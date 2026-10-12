/**
 * A project kept in sync with a branch of a Git repository on GitHub, GitLab, Gitee or any
 * other host. Members save their own access token (HTTPS) or SSH key per host; pushing and
 * pulling use the key of the member who does it.
 *
 * The server keeps a bare repository per project (`<root>/<project>.git`) and the commit the
 * project last matched (`base`). Pull merges what the branch changed since then into the
 * shared text, as an AI agent's edits are merged: where a collaborator changed the same lines
 * meanwhile, the pulled version becomes a suggestion (file-changes.ts). The first pull imports
 * the branch, its files replacing same-named ones (a version is saved first). Push commits the
 * whole project on top of `base` and is refused while the branch has commits not pulled yet.
 * Files the project cannot hold (hidden ones like .gitignore, or beyond the size limits) are
 * left as they are in the repository.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validPath } from "@lmms-lab/sync";
import type { AgentChangeResult } from "../shared/agents";
import type { Collaboration } from "./collaboration";
import { applyFileChanges } from "./file-changes";
import type { Store } from "./store";
import { decodeText, fail, isTextPath, uid } from "./util";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TIMEOUT = 180_000;
/** applyFileChanges takes at most this many changes at once. */
const BATCH = 200;

export type GitKind = "token" | "ssh";
export type GitCredential = {
  kind: GitKind;
  username: string | null;
  secret: string;
  authorName: string | null;
  authorEmail: string | null;
};
export type GitRemote = { url: string; branch: string; base: string | null; untracked: string[] };
export type GitAuthor = { name: string; email: string };

/** The host a repository address names, and whether it needs a token or an SSH key. */
export function parseRemote(
  url: string,
  allowFile = false,
): { host: string; kind: GitKind | null } {
  const value = url.trim();
  if (!value || value.length > 500 || value.startsWith("-") || /\s/.test(value))
    fail(400, "无效的仓库地址");
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)[A-Za-z0-9._~/-]+$/.exec(value);
  if (scp?.[1]) return { host: scp[1].toLowerCase(), kind: "ssh" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(400, "无效的仓库地址");
  }
  if (parsed.protocol === "file:" && allowFile) return { host: "file", kind: null };
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:")
    fail(400, "仓库地址需以 https:// 开头，或是 git@主机:路径 形式的 SSH 地址");
  if (parsed.protocol === "https:" && (parsed.username || parsed.password))
    fail(400, "不要把用户名或令牌写在仓库地址里，请填在下面的凭据里");
  if (!parsed.hostname || parsed.pathname.length < 2) fail(400, "无效的仓库地址");
  return {
    host: parsed.hostname.toLowerCase(),
    kind: parsed.protocol === "https:" ? "token" : "ssh",
  };
}
export function branchName(value: string) {
  const name = value.trim();
  if (
    !/^[A-Za-z0-9._/-]{1,100}$/.test(name) ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//")
  )
    fail(400, "无效的分支名");
  return name;
}
/** Git's object name for these bytes, to tell whether a file differs from a commit's. */
const blobId = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function utf8(bytes: Buffer) {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text.replace(/^﻿/, "") : null;
}

type Entry = { mode: string; id: string; path: string };
type Run = { input?: Buffer | string; credential?: GitCredential | null; raw?: boolean };

export class GitSync {
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    private store: Store,
    private collab: Collaboration,
    private root: string,
    private binary = "git",
    private allowFile = false,
  ) {}
  /** Whether file:// repositories are allowed (tests only: they would expose the server's disk). */
  get allowsFile() {
    return this.allowFile;
  }

  /** One Git operation per project at a time: they share its repository and `base`. */
  exclusive<T>(project: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(project) ?? Promise.resolve();
    const next = previous.then(action, action);
    const settled = next.catch(() => {});
    this.locks.set(project, settled);
    void settled.then(() => {
      if (this.locks.get(project) === settled) this.locks.delete(project);
    });
    return next;
  }
  repo(project: string) {
    return join(this.root, `${project}.git`);
  }
  async remove(project: string) {
    await rm(this.repo(project), { recursive: true, force: true });
  }

  private async git(args: string[], options: Run = {}): Promise<Buffer> {
    await mkdir(this.root, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GIT_ALLOW_PROTOCOL: this.allowFile ? "https:ssh:file" : "https:ssh",
      // Only what is set here: no user or system credential helpers, line-ending rewrites.
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(this.root, "empty-gitconfig"),
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "gc.auto",
      GIT_CONFIG_VALUE_1: "0",
      GIT_CONFIG_KEY_2: "credential.helper",
      GIT_CONFIG_VALUE_2: "",
    };
    await writeFile(env.GIT_CONFIG_GLOBAL as string, "", { flag: "a" });
    let key: string | null = null;
    const credential = options.credential;
    if (credential?.kind === "token") {
      const basic = Buffer.from(`${credential.username || "git"}:${credential.secret}`).toString(
        "base64",
      );
      env.GIT_CONFIG_COUNT = "4";
      env.GIT_CONFIG_KEY_3 = "http.extraHeader";
      env.GIT_CONFIG_VALUE_3 = `Authorization: Basic ${basic}`;
    } else if (credential?.kind === "ssh") {
      await mkdir(join(this.root, ".keys"), { recursive: true, mode: 0o700 });
      key = join(this.root, ".keys", uid());
      await writeFile(key, `${credential.secret.trim()}\n`, { mode: 0o600 });
      // ssh refuses a key others may read; on Windows that is the file's ACL, not its mode.
      if (process.platform === "win32")
        await new Promise((done) =>
          spawn(
            "icacls",
            [key as string, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`],
            {
              windowsHide: true,
            },
          ).on("close", done),
        );
      const quote = (path: string) => `'${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
      env.GIT_SSH_COMMAND = [
        "ssh",
        `-i ${quote(key)}`,
        "-o IdentitiesOnly=yes",
        "-o BatchMode=yes",
        "-o StrictHostKeyChecking=accept-new",
        `-o UserKnownHostsFile=${quote(join(this.root, "known_hosts"))}`,
        "-o ConnectTimeout=20",
      ].join(" ");
    }
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        let child: ChildProcess;
        try {
          child = spawn(this.binary, args, {
            cwd: this.root,
            env,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (error) {
          reject(error);
          return;
        }
        const out: Buffer[] = [],
          err: Buffer[] = [];
        child.stdout?.on("data", (d: Buffer) => out.push(d));
        child.stderr?.on("data", (d: Buffer) => err.push(d));
        const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          if (code === 0) resolve(Buffer.concat(out));
          else
            reject(
              new GitError(
                signal ? "timed out" : Buffer.concat(err).toString("utf8").trim(),
                code ?? -1,
              ),
            );
        });
        child.stdin?.on("error", () => {});
        child.stdin?.end(options.input ?? "");
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        fail(500, "服务器上没有找到 git，请安装 Git 或设置 WRITER_GIT");
      throw error;
    } finally {
      if (key) await rm(key, { force: true });
    }
  }
  /**
   * Runs git in the project's bare repository (named explicitly, so a data folder inside some
   * other checkout is never mistaken for it), turning failures into clear messages.
   */
  private async inRepo(project: string, args: string[], options: Run = {}) {
    const repo = this.repo(project);
    try {
      await access(join(repo, "HEAD"));
    } catch {
      await this.git(["init", "--bare", "-q", repo]);
    }
    try {
      return await this.git([`--git-dir=${repo}`, ...args], options);
    } catch (error) {
      throw error instanceof GitError && !options.raw ? remoteError(error) : error;
    }
  }

  /** The branch's newest commit, or null when it does not exist (yet). */
  async remoteHead(
    project: string,
    remote: { url: string; branch: string },
    credential: GitCredential | null,
  ) {
    const out = await this.inRepo(
      project,
      ["ls-remote", "--", remote.url, `refs/heads/${remote.branch}`],
      {
        credential,
      },
    );
    return out.toString("utf8").split(/\s/)[0] || null;
  }
  private async fetch(project: string, remote: GitRemote, credential: GitCredential | null) {
    await this.inRepo(
      project,
      [
        "fetch",
        "--no-tags",
        "-q",
        "--",
        remote.url,
        `+refs/heads/${remote.branch}:refs/writer/remote`,
      ],
      { credential },
    );
    return (await this.inRepo(project, ["rev-parse", "refs/writer/remote"])).toString().trim();
  }
  private async has(project: string, commit: string) {
    try {
      await this.inRepo(project, ["cat-file", "-e", `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }
  private async tree(project: string, commit: string | null): Promise<Entry[]> {
    if (!commit) return [];
    const out = await this.inRepo(project, ["ls-tree", "-r", "-z", commit]);
    return out
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta = "", path = ""] = line.split("\t");
        const [mode = "", , id = ""] = meta.split(" ");
        return { mode, id, path };
      });
  }
  /** Several blobs at once, by object name. */
  private async blobs(project: string, ids: string[]) {
    const wanted = [...new Set(ids)];
    const found = new Map<string, Buffer>();
    if (!wanted.length) return found;
    const out = await this.inRepo(project, ["cat-file", "--batch"], {
      input: `${wanted.join("\n")}\n`,
    });
    let at = 0;
    while (at < out.length) {
      const end = out.indexOf(10, at);
      const [id = "", type, size] = out.subarray(at, end).toString().split(" ");
      at = end + 1;
      if (type === "missing" || !size) continue;
      found.set(id, out.subarray(at, at + Number(size)));
      at += Number(size) + 1;
    }
    return found;
  }
  /** The project's files as Git would store them. */
  private async projectBytes(project: string) {
    const files = await this.store.projectFiles(project);
    return files.map((f) => ({
      path: f.path,
      revision: f.revision,
      binary: f.binary,
      bytes: f.binary ? Buffer.from(f.state) : Buffer.from(decodeText(f.state), "utf8"),
    }));
  }

  /** How many project files differ from the last synced commit, or null before the first sync. */
  async changedFiles(project: string, remote: GitRemote) {
    if (!remote.base || !(await this.has(project, remote.base))) return null;
    const base = new Map(
      (await this.tree(project, remote.base)).map((e) => [e.path, e.id] as const),
    );
    const files = await this.projectBytes(project);
    let changed = 0;
    for (const f of files) {
      if (base.get(f.path) !== blobId(f.bytes)) changed++;
      base.delete(f.path);
    }
    for (const path of base.keys()) if (!remote.untracked.includes(path)) changed++;
    return changed;
  }

  /**
   * Merges the branch's commits since `base` into the project. Returns the new `base`, the files
   * the project could not take (left untouched in the repository) and what became of each change.
   */
  async pull(
    project: string,
    actor: string,
    remote: GitRemote,
    credential: GitCredential | null,
    /** Called once before anything changes, e.g. to save a version. */
    beforeChanges?: () => Promise<void>,
  ): Promise<{ base: string | null; untracked: string[]; results: AgentChangeResult[] }> {
    const head = await this.remoteHead(project, remote, credential);
    if (!head) return { base: remote.base, untracked: remote.untracked, results: [] };
    if (head === remote.base) return { base: head, untracked: remote.untracked, results: [] };
    await this.fetch(project, remote, credential);
    // A branch rewritten so the old base is gone is imported again, as on the first pull.
    const base = remote.base && (await this.has(project, remote.base)) ? remote.base : null;
    const before = await this.tree(project, base);
    const after = await this.tree(project, head);
    const old = new Map(before.map((e) => [e.path, e] as const));
    const next = new Map(after.map((e) => [e.path, e] as const));
    const current = new Map((await this.projectBytes(project)).map((f) => [f.path, f] as const));
    const contents = await this.blobs(
      project,
      [...before, ...after].map((e) => e.id),
    );
    const changes: Record<string, unknown>[] = [];
    const results: AgentChangeResult[] = [];
    const regular = (e?: Entry) => !!e && (e.mode === "100644" || e.mode === "100755");
    for (const path of new Set([...old.keys(), ...next.keys()])) {
      const a = old.get(path),
        b = next.get(path);
      if (a?.id === b?.id && a?.mode === b?.mode) continue;
      if (!validPath(path) || (b && !regular(b))) continue;
      const mine = current.get(path);
      // The project's copy counts as unchanged when it still matches what was last synced
      // (or, on the first pull, always: the branch's files replace same-named ones).
      const unchangedHere = !base || (!!mine && !!a && blobId(mine.bytes) === a.id);
      if (!b) {
        if (!mine) continue;
        changes.push(
          isTextPath(path)
            ? {
                path,
                deleted: true,
                base: a ? (utf8(contents.get(a.id) ?? Buffer.alloc(0)) ?? "") : "",
              }
            : { path, deleted: true, revision: unchangedHere ? mine.revision : -1 },
        );
        continue;
      }
      const bytes = contents.get(b.id) ?? Buffer.alloc(0);
      if (isTextPath(path)) {
        const content = utf8(bytes);
        if (content === null) {
          results.push({ path, status: "skipped", reason: "不是 UTF-8 文本" });
          continue;
        }
        const was = !base
          ? mine && !mine.binary
            ? mine.bytes.toString("utf8")
            : ""
          : a
            ? (utf8(contents.get(a.id) ?? Buffer.alloc(0)) ?? "")
            : "";
        changes.push({ path, base: was, content });
      } else {
        changes.push({
          path,
          base64: bytes.toString("base64"),
          revision: mine ? (unchangedHere ? mine.revision : -1) : null,
        });
      }
    }
    if (changes.length) await beforeChanges?.();
    for (let i = 0; i < changes.length; i += BATCH)
      results.push(
        ...(await applyFileChanges(
          this.store,
          this.collab,
          project,
          actor,
          changes.slice(i, i + BATCH),
          await this.store.tracking(project, actor, "Git"),
        )),
      );
    if (changes.length) this.collab.changed(project);
    const kept = new Set((await this.store.projectFiles(project)).map((f) => f.path));
    return {
      base: head,
      untracked: after.filter((e) => !kept.has(e.path)).map((e) => e.path),
      results,
    };
  }

  /**
   * Commits the project on top of `base` and pushes it. Null when there is nothing to push;
   * throws 409 when the branch has commits the project has not pulled.
   */
  async push(
    project: string,
    remote: GitRemote,
    credential: GitCredential | null,
    author: GitAuthor,
    message: string,
  ): Promise<string | null> {
    const head = await this.remoteHead(project, remote, credential);
    if (head && head !== remote.base) fail(409, "仓库分支有新的提交，请先拉取");
    if (remote.base && !(await this.has(project, remote.base)))
      await this.fetch(project, remote, credential);
    const files = await this.projectBytes(project);
    const present = new Set(files.map((f) => f.path));
    // Kept as the repository has them: files the project could not take in.
    const kept = (await this.tree(project, remote.base)).filter(
      (e) => !present.has(e.path) && (remote.untracked.includes(e.path) || !validPath(e.path)),
    );
    const now = Math.floor(Date.now() / 1000);
    const who = `${author.name.replace(/[<>\n]/g, "")} <${author.email.replace(/[<>\n]/g, "")}> ${now} +0000`;
    const text = Buffer.from(message, "utf8");
    const parts: Buffer[] = [
      Buffer.from(
        `commit refs/writer/push\nauthor ${who}\ncommitter ${who}\ndata ${text.length}\n`,
      ),
      text,
      Buffer.from(`\n${remote.base ? `from ${remote.base}\n` : ""}deleteall\n`),
    ];
    for (const e of kept) parts.push(Buffer.from(`M ${e.mode} ${e.id} ${e.path}\n`));
    for (const f of files) {
      parts.push(Buffer.from(`M 100644 inline ${f.path}\ndata ${f.bytes.length}\n`), f.bytes);
      parts.push(Buffer.from("\n"));
    }
    parts.push(Buffer.from("done\n"));
    await this.inRepo(project, ["fast-import", "--quiet", "--done", "--force"], {
      input: Buffer.concat(parts),
    });
    const commit = (await this.inRepo(project, ["rev-parse", "refs/writer/push"]))
      .toString()
      .trim();
    const tree = async (rev: string | null) =>
      rev
        ? (await this.inRepo(project, ["rev-parse", `${rev}^{tree}`])).toString().trim()
        : EMPTY_TREE;
    if ((await tree(commit)) === (await tree(remote.base))) return null;
    try {
      await this.inRepo(
        project,
        ["push", "-q", "--", remote.url, `${commit}:refs/heads/${remote.branch}`],
        { credential, raw: true },
      );
    } catch (error) {
      if (
        error instanceof GitError &&
        /rejected|non-fast-forward|fetch first|stale info/i.test(error.message)
      )
        fail(409, "仓库分支有新的提交，请先拉取");
      throw error instanceof GitError ? remoteError(error) : error;
    }
    return commit;
  }
}

class GitError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}
/** What went wrong talking to the repository, without echoing anything secret. */
function remoteError(error: GitError): never {
  const text = error.message;
  if (
    /timed out|Connection timed out|Could not resolve host|unable to access|Connection refused|Network is unreachable|Operation timed out/i.test(
      text,
    )
  )
    fail(502, "连不上 Git 仓库，请检查地址和网络");
  if (
    /Authentication failed|could not read Username|Permission denied|403|401|access denied|Invalid username or password|HTTP Basic/i.test(
      text,
    )
  )
    fail(403, "仓库拒绝了你的凭据，请检查令牌或 SSH 密钥及其权限");
  if (
    /not found|does not appear to be a git repository|Repository not found|does not exist/i.test(
      text,
    )
  )
    fail(404, "找不到这个仓库，或你的凭据没有访问权限");
  const line = text.split("\n").filter(Boolean).at(-1) ?? "";
  fail(502, "Git 操作失败：{detail}", {
    detail: line.replace(/Authorization:[^\s]*\s*\S*/gi, "").slice(0, 200),
  });
}
