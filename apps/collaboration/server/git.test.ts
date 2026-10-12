import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRemote } from "./git";
import { fixture } from "./test-fixture";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** A repository on "the host" (a bare one on disk) and a clone to make commits there. */
async function repository() {
  const dir = await mkdtemp(join(tmpdir(), "writer-git-test-"));
  dirs.push(dir);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
        GIT_AUTHOR_NAME: "Host User",
        GIT_AUTHOR_EMAIL: "host@example.com",
        GIT_COMMITTER_NAME: "Host User",
        GIT_COMMITTER_EMAIL: "host@example.com",
      },
    })
      .toString()
      .trim();
  await writeFile(join(dir, "gitconfig"), "");
  git(dir, "init", "--bare", "-q", "-b", "main", "remote.git");
  git(dir, "clone", "-q", "remote.git", "work");
  const work = join(dir, "work");
  const write = (path: string, content: string | Buffer) => writeFile(join(work, path), content);
  await write(
    "main.tex",
    "\\documentclass{article}\n\\begin{document}\nFirst line.\nSecond line.\n\\end{document}\n",
  );
  await write("refs.bib", "@article{a,\n  title = {A}\n}\n");
  await write("figure.png", PNG);
  await write(".gitignore", "*.aux\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "Start");
  git(work, "push", "-q", "origin", "main");
  return {
    url: `file://${join(dir, "remote.git")}`,
    work,
    write,
    read: (path: string) => readFile(join(work, path), "utf8"),
    git: (...args: string[]) => git(work, ...args),
    commit: (message: string) => {
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", message);
      git(work, "push", "-q", "origin", "main");
    },
  };
}

describe("Git sync", () => {
  it("only takes https and ssh addresses, without secrets in them", () => {
    expect(parseRemote("https://github.com/lab/paper.git")).toEqual({
      host: "github.com",
      kind: "token",
    });
    expect(parseRemote("git@gitee.com:lab/paper.git")).toEqual({ host: "gitee.com", kind: "ssh" });
    expect(parseRemote("ssh://git@gitlab.com:2222/lab/paper.git").kind).toBe("ssh");
    for (const bad of [
      "https://user:token@github.com/lab/paper.git",
      "file:///etc",
      "/home/writer/repo",
      "-uhack",
      "ext::sh -c touch% /tmp/x",
      "http://github.com/lab/paper.git",
    ])
      expect(() => parseRemote(bad)).toThrow();
  });

  it("imports a branch, pushes edits and merges commits made on both sides", async () => {
    const host = await repository();
    const dir = await mkdtemp(join(tmpdir(), "writer-git-server-"));
    dirs.push(dir);
    const f = await fixture({ git: { directory: dir, allowFile: true } });
    const p = `/projects/${f.project}`;
    const viewer = await f.invite("viewer", "reader");

    expect((await f.call(`${p}/git/link`, { url: host.url, branch: "main" }, viewer)).status).toBe(
      403,
    );
    expect(
      (await f.call(`${p}/git/link`, { url: host.url, branch: "main" }, f.owner)).data,
    ).toEqual({ exists: true });
    // The first pull imports the branch: its main.tex replaces the new project's.
    const first = await f.call(`${p}/git/pull`, {}, f.owner);
    expect(first.data).toMatchObject({ proposals: 0, skipped: [] });
    expect(first.data.applied).toBeGreaterThanOrEqual(3);
    const files = async () =>
      (await f.call(`${p}/files`, undefined, f.owner)).data as Array<{
        id: string;
        path: string;
        binary: boolean;
      }>;
    const text = async (path: string) => {
      const file = (await files()).find((x) => x.path === path);
      return file
        ? ((await f.call(`${p}/files/${file.id}`, undefined, f.owner)).data.content as string)
        : null;
    };
    expect(await text("main.tex")).toContain("First line.");
    expect((await files()).map((x) => x.path)).toEqual(
      expect.arrayContaining(["main.tex", "refs.bib", "figure.png"]),
    );
    let status = (await f.call(`${p}/git`, undefined, f.owner)).data;
    expect(status).toMatchObject({
      changed: 0,
      remote: { branch: "main", action: "pull", untracked: 1 },
    });
    const versions = (await f.call(`${p}/snapshots`, undefined, f.owner)).data as Array<{
      label: string;
    }>;
    expect(versions.map((v) => v.label)).toContain("Git 拉取前");

    // An edit in Writer, pushed as one commit by the member.
    const edit = async (path: string, change: (s: string) => string) => {
      const file = (await files()).find((x) => x.path === path);
      const current = (await text(path)) as string;
      const saved = await f.call(
        `${p}/files/${file?.id}`,
        { expected: current, content: change(current) },
        f.owner,
        "PUT",
      );
      expect(saved.status).toBe(200);
    };
    await edit("main.tex", (s) => s.replace("Second line.", "Second line, edited in Writer."));
    expect((await f.call(`${p}/git`, undefined, f.owner)).data.changed).toBe(1);
    const pushed = await f.call(`${p}/git/push`, { message: "Edit the second line" }, f.owner);
    expect(pushed.data.commit).toMatch(/^[0-9a-f]{40}$/);
    host.git("pull", "-q", "origin", "main");
    expect(await host.read("main.tex")).toContain("Second line, edited in Writer.");
    expect(await host.read(".gitignore")).toBe("*.aux\n");
    expect(host.git("log", "-1", "--format=%an <%ae> %s")).toBe(
      "owner <owner@users.noreply.writer> Edit the second line",
    );
    // Nothing new: nothing pushed.
    expect((await f.call(`${p}/git/push`, {}, f.owner)).data.commit).toBeNull();

    // Commits on both sides: push waits for a pull, which merges the other lines.
    const main = await host.read("main.tex");
    await host.write("main.tex", main.replace("First line.", "First line, from the host."));
    await host.write("figure.png", Buffer.concat([PNG, Buffer.from([1, 2, 3])]));
    await host.write("notes.tex", "New file from the host.\n");
    host.commit("Host edits");
    await edit("main.tex", (s) => s.replace("\\end{document}", "Third line.\n\\end{document}"));
    expect((await f.call(`${p}/git/push`, {}, f.owner)).status).toBe(409);
    const merged = await f.call(`${p}/git/pull`, {}, f.owner);
    expect(merged.data).toMatchObject({ proposals: 0, skipped: [] });
    const after = (await text("main.tex")) as string;
    expect(after).toContain("First line, from the host.");
    expect(after).toContain("Third line.");
    expect(await text("notes.tex")).toBe("New file from the host.\n");
    expect((await f.call(`${p}/git/push`, { message: "Third line" }, f.owner)).data.commit).toMatch(
      /^[0-9a-f]{40}$/,
    );
    host.git("pull", "-q", "origin", "main");
    expect(await host.read("main.tex")).toContain("Third line.");
    expect((await readFile(join(host.work, "figure.png"))).length).toBe(PNG.length + 3);

    // The same line changed on both sides: the host's version waits as a suggestion.
    await host.write(
      "main.tex",
      (await host.read("main.tex")).replace("Third line.", "Third line (host)."),
    );
    host.commit("Host rewords");
    await edit("main.tex", (s) => s.replace("Third line.", "Third line (Writer)."));
    const conflict = await f.call(`${p}/git/pull`, {}, f.owner);
    expect(conflict.data.proposals).toBe(1);
    expect(await text("main.tex")).toContain("Third line (Writer).");

    // A file deleted on the host goes, unless it was changed here.
    host.git("rm", "-q", "notes.tex");
    host.commit("Remove notes");
    await f.call(`${p}/git/pull`, {}, f.owner);
    expect((await files()).map((x) => x.path)).not.toContain("notes.tex");

    await f.call(`${p}/git/unlink`, {}, f.owner);
    status = (await f.call(`${p}/git`, undefined, f.owner)).data;
    expect(status).toEqual({ remote: null, changed: null, hasCredential: false });
  });

  it("keeps each member's credentials to themselves and needs one for the host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writer-git-server-"));
    dirs.push(dir);
    const f = await fixture({ git: { directory: dir } });
    const editor = await f.invite("editor", "coauthor");
    const p = `/projects/${f.project}`;
    expect(
      (
        await f.call(
          `${p}/git/link`,
          { url: "https://github.com/lab/paper.git", branch: "main" },
          f.owner,
        )
      ).data.error,
    ).toContain("github.com");
    expect(
      (await f.call("/me/git", { host: "github.com", kind: "token", secret: "short" }, f.owner))
        .status,
    ).toBe(400);
    expect(
      (
        await f.call(
          "/me/git",
          {
            host: "github.com",
            kind: "token",
            username: "lab",
            secret: "ghp_0123456789abcdef",
            authorEmail: "me@lab.org",
          },
          f.owner,
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.call("/me/git", { host: "gitee.com", kind: "ssh", secret: "not a key" }, f.owner))
        .status,
    ).toBe(400);
    const mine = (await f.call("/me/git", undefined, f.owner)).data;
    expect(mine).toEqual([
      expect.objectContaining({ host: "github.com", kind: "token", username: "lab" }),
    ]);
    expect(JSON.stringify(mine)).not.toContain("ghp_");
    expect((await f.call("/me/git", undefined, editor)).data).toEqual([]);
    await f.call("/me/git/remove", { host: "github.com", kind: "token" }, f.owner);
    expect((await f.call("/me/git", undefined, f.owner)).data).toEqual([]);
  });
});
