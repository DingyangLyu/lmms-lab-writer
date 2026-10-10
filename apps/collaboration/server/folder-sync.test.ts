import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderSync, type SyncNotice } from "@lmms-lab/sync";
import { jsonFileStore, nodeFolder, nodeTransport } from "@lmms-lab/sync/node";
import { afterEach, describe, expect, it } from "vitest";
import { fixture } from "./test-fixture";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function until(check: () => Promise<boolean> | boolean, what: string, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup(user = "owner") {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "writer-folder-sync-"));
  stops.push(() => rm(dir, { recursive: true, force: true }));
  const token = async (username: string) =>
    (
      (await (
        await fetch(`${f.app.origin}/api/tokens`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password: "test-password-1234", name: "test" }),
        })
      ).json()) as { token: string }
    ).token;
  const notices: SyncNotice[] = [];
  const engine = async (as = user) => {
    const sync = new FolderSync({
      project: f.project,
      transport: nodeTransport(f.app.origin, await token(as)),
      folder: nodeFolder(dir),
      store: jsonFileStore(join(dir, ".writer", "sync.json")),
      onNotice: (n) => notices.push(n),
      textDelay: 20,
      deleteDelay: 200,
      rescanInterval: 0,
    });
    stops.push(() => sync.stop());
    await sync.start();
    return sync;
  };
  const api = (path: string, body?: unknown, method?: string) =>
    f.call(`/projects/${f.project}${path}`, body, f.owner, method);
  const files = async () =>
    (await api("/files")).data as { id: string; path: string; binary: boolean; revision: number }[];
  const remote = async (path: string) => {
    const file = (await files()).find((x) => x.path === path);
    return file ? (await api(`/files/${file.id}`)).data : null;
  };
  const local = (path: string) => readFile(join(dir, path), "utf8").catch(() => null);
  const put = (path: string, content: string | Uint8Array) => writeFile(join(dir, path), content);
  return { f, dir, engine, api, files, remote, local, put, notices, token };
}

describe("desktop folder sync against the real server", () => {
  it("keeps Windows line endings out of the shared text", async () => {
    const s = await setup();
    await s.api("/files", { path: "w.tex", content: "one\ntwo\n" });
    const sync = await s.engine();
    await until(async () => (await s.local("w.tex")) === "one\ntwo\n", "clone of w.tex");
    const before = (await s.files()).find((x) => x.path === "w.tex")?.revision;
    // An editor on Windows saves the same text with "\r\n": nothing to upload.
    await s.put("w.tex", "one\r\ntwo\r\n");
    sync.notifyLocal(["w.tex"]);
    await new Promise((r) => setTimeout(r, 300));
    expect((await s.remote("w.tex"))?.content).toBe("one\ntwo\n");
    expect((await s.files()).find((x) => x.path === "w.tex")?.revision).toBe(before);
    // A real change goes up without the "\r"; so does a new file.
    await s.put("w.tex", "one\r\ntwo!\r\n");
    await s.put("n.tex", "new\r\nfile\r\n");
    sync.notifyLocal(["w.tex", "n.tex"]);
    await until(async () => (await s.remote("w.tex"))?.content === "one\ntwo!\n", "upload");
    await until(async () => (await s.remote("n.tex"))?.content === "new\nfile\n", "new file");
  });

  it("clones a project and merges concurrent edits from the web editor and the folder", async () => {
    const s = await setup();
    const a = (await s.api("/files", { path: "a.tex", content: "alpha\nbeta\n" })).data.id;
    await s.api("/files", { path: "fig.png", base64: "AAEC" });
    const sync = await s.engine();
    await until(async () => (await s.local("a.tex")) === "alpha\nbeta\n", "clone of a.tex");
    expect([...(await readFile(join(s.dir, "fig.png")))]).toEqual([0, 1, 2]);

    await s.put("a.tex", "alpha!\nbeta\n");
    sync.notifyLocal(["a.tex"]);
    await until(async () => (await s.remote("a.tex"))?.content === "alpha!\nbeta\n", "upload");

    const web = await s.f.peer(s.f.owner, a);
    const text = web.doc.getText("content");
    web.send(
      "w1",
      web.capture(() => text.insert(text.length, "gamma\n")),
    );
    await until(async () => (await s.local("a.tex")) === "alpha!\nbeta\ngamma\n", "remote edit");

    // Both sides at once, in different places.
    web.send(
      "w2",
      web.capture(() => text.insert(0, "X")),
    );
    await s.put("a.tex", "alpha!\nBETA\ngamma\n");
    sync.notifyLocal(["a.tex"]);
    const merged = "Xalpha!\nBETA\ngamma\n";
    await until(async () => (await s.local("a.tex")) === merged, "merged local file");
    await until(async () => (await s.remote("a.tex"))?.content === merged, "merged server text");
  });

  it("uploads, renames, replaces and deletes local files", async () => {
    const s = await setup();
    const sync = await s.engine();
    await s.put("new.tex", "fresh");
    await s.put("plot.png", new Uint8Array([9, 9]));
    sync.notifyLocal();
    await until(async () => (await s.remote("new.tex"))?.content === "fresh", "new text file");
    await until(async () => (await s.remote("plot.png"))?.base64 === "CQk=", "new figure");
    const id = (await s.files()).find((f) => f.path === "new.tex")?.id;

    await rename(join(s.dir, "new.tex"), join(s.dir, "renamed.tex"));
    sync.notifyLocal();
    await until(
      async () => (await s.files()).find((f) => f.id === id)?.path === "renamed.tex",
      "rename kept the file's identity",
    );

    await s.put("plot.png", new Uint8Array([7]));
    sync.notifyLocal();
    await until(async () => (await s.remote("plot.png"))?.base64 === "Bw==", "replaced figure");
    expect((await s.remote("plot.png"))?.revision).toBe(2);

    await rm(join(s.dir, "renamed.tex"));
    sync.notifyLocal();
    await until(async () => !(await s.files()).some((f) => f.id === id), "deleted remotely");
  });

  it("follows remote creations, renames and deletions without losing unsynced local edits", async () => {
    const s = await setup();
    const sync = await s.engine();
    const b = (await s.api("/files", { path: "b.tex", content: "bee" })).data.id;
    await until(async () => (await s.local("b.tex")) === "bee", "remote creation");
    await s.api(`/files/${b}`, { path: "sub/c.tex" }, "PATCH");
    await until(async () => (await s.local("sub/c.tex")) === "bee", "remote rename");
    expect(await s.local("b.tex")).toBeNull();
    await s.api(`/files/${b}`, undefined, "DELETE");
    await until(async () => (await s.local("sub/c.tex")) === null, "remote deletion");

    // Edited locally while the app was closed, deleted remotely meanwhile: kept as a copy.
    const d = (await s.api("/files", { path: "d.tex", content: "draft" })).data.id;
    await until(async () => (await s.local("d.tex")) === "draft", "d.tex");
    await sync.idle();
    await sync.stop();
    await s.put("d.tex", "draft with my notes");
    await s.api(`/files/${d}`, undefined, "DELETE");
    await s.engine();
    await until(() => s.notices.some((n) => n.kind === "deleted-remotely"), "notice");
    const notice = s.notices.find((n) => n.kind === "deleted-remotely");
    expect(notice && "copy" in notice && (await s.local(notice.copy))).toBe("draft with my notes");
    expect(await s.local("d.tex")).toBeNull();
    // The copy stays local.
    await new Promise((r) => setTimeout(r, 300));
    expect((await s.files()).map((f) => f.path)).not.toContain(
      notice && "copy" in notice ? notice.copy : "",
    );
  });

  it("merges edits made on both sides while the app was closed", async () => {
    const s = await setup();
    const id = (await s.api("/files", { path: "main.tex", content: "one\ntwo\nthree\n" })).data.id;
    const first = await s.engine();
    await until(async () => (await s.local("main.tex")) === "one\ntwo\nthree\n", "clone");
    await first.idle();
    await first.stop();

    await s.put("main.tex", "ONE\ntwo\nthree\n");
    const web = await s.f.peer(s.f.owner, id);
    const text = web.doc.getText("content");
    web.send(
      "w",
      web.capture(() => text.insert(text.length - 6, "THREE\n")),
    );
    await web.next("ack");

    await s.engine();
    const merged = "ONE\ntwo\nTHREE\nthree\n";
    await until(async () => (await s.local("main.tex")) === merged, "merged after restart");
    await until(async () => (await s.remote("main.tex"))?.content === merged, "server merged");
  });

  it("pauses instead of deleting when many files vanish at once", async () => {
    const s = await setup();
    for (const n of [1, 2, 3, 4, 5])
      await s.api("/files", { path: `ch${n}.tex`, content: `chapter ${n}` });
    const sync = await s.engine();
    await until(async () => (await s.local("ch5.tex")) === "chapter 5", "clone");
    for (const n of [1, 2, 3, 4]) await rm(join(s.dir, `ch${n}.tex`));
    sync.notifyLocal();
    await until(() => sync.status().state === "paused", "paused");
    expect(s.notices).toContainEqual({ kind: "paused-missing", count: 4 });
    await new Promise((r) => setTimeout(r, 300));
    expect((await s.files()).length).toBe(5);
    sync.resolveMissing("restore");
    await until(async () => (await s.local("ch1.tex")) === "chapter 1", "restored");
  });

  it("never uploads or overwrites a viewer's local edits", async () => {
    const s = await setup();
    await s.f.invite("viewer", "reader");
    await s.api("/files", { path: "paper.tex", content: "v1" });
    const sync = await s.engine("reader");
    await until(async () => (await s.local("paper.tex")) === "v1", "clone for viewer");
    await s.put("paper.tex", "my private edit");
    sync.notifyLocal(["paper.tex"]);
    await until(() => s.notices.some((n) => n.kind === "read-only"), "read-only notice");
    expect((await s.remote("paper.tex"))?.content).toBe("v1");
    expect(await s.local("paper.tex")).toBe("my private edit");
  });
});
