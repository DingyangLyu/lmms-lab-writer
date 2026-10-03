import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { createWriterServer } from "./app";

type Message = { type: string; state?: string; update?: string; id?: string; message?: string };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "writer-collab-test-"));
  let app = await createWriterServer({
    directory: dir,
    port: 0,
    adminUser: "owner",
    adminPassword: "test-password-1234",
  });
  cleanups.push(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (
    path: string,
    body?: unknown,
    cookie = "",
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`${app.origin}/api${path}`, {
      method,
      headers: { Origin: app.origin, "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  const owner = (await call("/login", { username: "owner", password: "test-password-1234" }))
    .cookie;
  const project = (await call("/projects", { name: "test-paper" }, owner)).data.id as string;
  const invite = async (role: string, name: string) => {
    const token = (await call(`/projects/${project}/invite`, { role }, owner)).data.token;
    return (await call("/join", { token, username: name, password: "test-password-1234" })).cookie;
  };
  const peer = async (cookie: string, file: string) => {
    const ws = new WebSocket(
      `${app.origin.replace("http:", "ws:")}/api/projects/${project}/socket?file=${file}`,
      { headers: { Cookie: cookie, Origin: app.origin } },
    );
    const queued: Message[] = [],
      waiters: Array<{ type: string; resolve: (m: Message) => void; reject: (e: Error) => void }> =
        [];
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString()) as Message;
      const index = waiters.findIndex((w) => w.type === m.type);
      if (index >= 0) waiters.splice(index, 1)[0]?.resolve(m);
      else queued.push(m);
    });
    const next = (type: string) => {
      const index = queued.findIndex((m) => m.type === type);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0] as Message);
      return new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`missing ${type}`)), 3000);
        waiters.push({
          type,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
          reject,
        });
      });
    };
    const ready = await next("ready");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(ready.state || "", "base64"));
    const send = (id: string, update: Uint8Array) =>
      ws.send(
        JSON.stringify({ type: "update", id, update: Buffer.from(update).toString("base64") }),
      );
    const capture = (change: () => void) => {
      let update: Uint8Array = new Uint8Array();
      const handler = (u: Uint8Array) => {
        update = u;
      };
      doc.on("update", handler);
      doc.transact(change);
      doc.off("update", handler);
      return update;
    };
    cleanups.push(async () => {
      ws.terminate();
      doc.destroy();
    });
    return { ws, doc, next, send, capture };
  };
  const restart = async () => {
    await app.close();
    app = await createWriterServer({ directory: dir, port: 0 });
  };
  return {
    call,
    owner,
    project,
    invite,
    peer,
    restart,
    get app() {
      return app;
    },
  };
}
describe("real collaboration service", () => {
  it("leases shared tasks only to scoped runners and submits AI changes as unapplied proposals", async () => {
    const f = await fixture();
    const file = (
      await f.call(
        `/projects/${f.project}/files`,
        { path: "main.tex", content: "Original.\n" },
        f.owner,
      )
    ).data.id;
    const token = (
      await f.call(
        `/projects/${f.project}/runners`,
        { name: "test-worker", capabilities: ["codex"] },
        f.owner,
      )
    ).data.token;
    const runner = async (path: string, body: unknown) => {
      const response = await fetch(`${f.app.origin}/api/runner/${path}`, {
        method: "POST",
        headers: {
          Origin: f.app.origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    const id = (
      await f.call(
        `/projects/${f.project}/jobs`,
        { harness: "codex", prompt: "Improve the paragraph." },
        f.owner,
      )
    ).data.id;
    const leased = await runner("lease", {});
    expect(leased.data.job.id).toBe(id);
    expect(leased.data.job.files[0].content).toBe("Original.\n");
    expect((await runner("lease", {})).data.job).toBeNull();
    expect(
      (
        await runner("result", {
          id,
          result: "ready",
          files: [{ path: "main.tex", content: "Revised.\n" }],
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.call(`/projects/${f.project}/files/${file}`, undefined, f.owner)).data.content,
    ).toBe("Original.\n");
    const proposals = (await f.call(`/projects/${f.project}/proposals`, undefined, f.owner)).data;
    expect(proposals).toHaveLength(1);
    expect((await runner("result", { id, result: "duplicate", files: [] })).status).toBe(409);
    const second = (
      await f.call(
        `/projects/${f.project}/jobs`,
        { harness: "codex", prompt: "Next task" },
        f.owner,
      )
    ).data.id;
    await runner("lease", {});
    await f.call(`/projects/${f.project}/jobs/${second}`, {}, f.owner, "DELETE");
    expect((await runner("heartbeat", { id: second })).status).toBe(409);
  });
  it("merges concurrent Chinese edits, acknowledges durable writes and survives restart", async () => {
    const f = await fixture(),
      editor = await f.invite("editor", "coauthor");
    const file = (
      await f.call(
        `/projects/${f.project}/files`,
        { path: "main.tex", content: "开始\n结束\n" },
        f.owner,
      )
    ).data.id;
    const a = await f.peer(f.owner, file),
      b = await f.peer(editor, file);
    const ua = a.capture(() => a.doc.getText("content").insert(3, "作者甲\n"));
    const ub = b.capture(() => b.doc.getText("content").insert(3, "作者乙\n"));
    a.send("a1", ua);
    b.send("b1", ub);
    await Promise.all([a.next("ack"), b.next("ack")]);
    Y.applyUpdate(a.doc, Buffer.from((await a.next("update")).update || "", "base64"));
    Y.applyUpdate(b.doc, Buffer.from((await b.next("update")).update || "", "base64"));
    expect(a.doc.getText("content").toString()).toBe(b.doc.getText("content").toString());
    expect(a.doc.getText("content").toString()).toContain("作者甲");
    expect(a.doc.getText("content").toString()).toContain("作者乙");
    const saved = (await f.call(`/projects/${f.project}/files/${file}`, undefined, f.owner)).data
      .content;
    expect(saved).toBe(a.doc.getText("content").toString());
    a.ws.close();
    b.ws.close();
    await f.restart();
    expect(
      (await f.call(`/projects/${f.project}/files/${file}`, undefined, f.owner)).data.content,
    ).toBe(saved);
    const offline = a.capture(() => a.doc.getText("content").insert(0, "离线新增\n"));
    const c = await f.peer(f.owner, file);
    c.send("offline", offline);
    await c.next("ack");
    expect(
      (await f.call(`/projects/${f.project}/files/${file}`, undefined, f.owner)).data.content,
    ).toContain("离线新增");
  });
  it("enforces roles, project isolation, live revocation and single-use invites", async () => {
    const f = await fixture(),
      viewer = await f.invite("viewer", "reader"),
      editor = await f.invite("editor", "editor");
    const file = (
      await f.call(
        `/projects/${f.project}/files`,
        { path: "main.tex", content: "original" },
        f.owner,
      )
    ).data.id;
    expect(
      (await f.call(`/projects/${f.project}/files`, { path: "evil.tex", content: "bad" }, viewer))
        .status,
    ).toBe(403);
    expect((await f.call("/projects/not-your-project/files", undefined, viewer)).status).toBe(403);
    expect(
      (
        await f.call(
          `/projects/${f.project}/files`,
          { path: "../escape.tex", content: "bad" },
          f.owner,
        )
      ).status,
    ).toBe(400);
    const readPeer = await f.peer(viewer, file),
      u = readPeer.capture(() => readPeer.doc.getText("content").insert(0, "bad"));
    readPeer.send("bad", u);
    expect((await readPeer.next("error")).message).toContain("不允许");
    const editPeer = await f.peer(editor, file),
      me = (await f.call("/me", undefined, editor)).data;
    const closed = new Promise<number>((resolve) =>
      editPeer.ws.once("close", (code) => resolve(code)),
    );
    expect(
      (await f.call(`/projects/${f.project}/members/${me.id}`, {}, f.owner, "DELETE")).status,
    ).toBe(200);
    expect(await closed).toBe(1008);
    expect((await f.call(`/projects/${f.project}/files`, undefined, editor)).status).toBe(403);
    expect(
      (await f.call(`/projects/${f.project}/files/${file}`, undefined, f.owner)).data.content,
    ).toBe("original");
    const token = (await f.call(`/projects/${f.project}/invite`, { role: "commenter" }, f.owner))
      .data.token;
    expect(
      (await f.call("/join", { token, username: "third", password: "test-password-1234" })).status,
    ).toBe(200);
    expect(
      (await f.call("/join", { token, username: "fourth", password: "test-password-1234" })).status,
    ).toBe(410);
    const forged = await fetch(`${f.app.origin}/api/projects`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Cookie: f.owner,
        "Content-Type": "application/json",
      },
      body: '{"name":"bad"}',
    });
    expect(forged.status).toBe(403);
  });
  it("keeps anchored comments, replies, decisions and restorable versions", async () => {
    const f = await fixture(),
      reviewer = await f.invite("commenter", "reviewer");
    const file = (
      await f.call(
        `/projects/${f.project}/files`,
        { path: "main.tex", content: "alpha\nbeta\n" },
        f.owner,
      )
    ).data.id;
    const p = await f.peer(f.owner, file),
      text = p.doc.getText("content");
    const start = Buffer.from(
        Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 0)),
      ).toString("base64"),
      end = Buffer.from(
        Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 5)),
      ).toString("base64");
    const comment = (
      await f.call(
        `/projects/${f.project}/comments`,
        { file, start, end, quote: "alpha", body: "请解释这个段落" },
        reviewer,
      )
    ).data.id;
    expect(
      (
        await f.call(
          `/projects/${f.project}/comments/${comment}/reply`,
          { body: "已核对" },
          f.owner,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call(
          `/projects/${f.project}/comments/${comment}`,
          { resolved: true },
          f.owner,
          "PATCH",
        )
      ).status,
    ).toBe(200);
    const notes = (await f.call(`/projects/${f.project}/comments`, undefined, f.owner)).data;
    expect(notes[0].resolved).toBe(1);
    expect(notes[0].replies[0].body).toBe("已核对");
    const snapshot = (
      await f.call(`/projects/${f.project}/snapshots`, { label: "before" }, f.owner)
    ).data.id;
    const proposal = (
      await f.call(
        `/projects/${f.project}/proposals`,
        { file, base: "alpha\nbeta\n", proposed: "Alpha revised\nbeta\n" },
        f.owner,
      )
    ).data.id;
    await f.call(
      `/projects/${f.project}/files/${file}`,
      { expected: "alpha\nbeta\n", content: "alpha\nbeta by colleague\n" },
      f.owner,
      "PUT",
    );
    expect(
      (
        await f.call(
          `/projects/${f.project}/proposals/${proposal}/decide`,
          { revision: 1, part: 0, status: "accepted" },
          f.owner,
        )
      ).status,
    ).toBe(200);
    const current = (await f.call(`/projects/${f.project}/files/${file}`, undefined, f.owner)).data
      .content;
    expect(current).toBe("Alpha revised\nbeta by colleague\n");
    expect(
      (
        await f.call(
          `/projects/${f.project}/snapshots/${snapshot}/restore`,
          { file, expected: "stale" },
          f.owner,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await f.call(
          `/projects/${f.project}/snapshots/${snapshot}/restore`,
          { file, expected: current },
          f.owner,
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.call(`/projects/${f.project}/files/${file}`, undefined, f.owner)).data.content,
    ).toBe("alpha\nbeta\n");
    expect((await f.call(`/projects/${f.project}/comments`, undefined, f.owner)).data).toHaveLength(
      1,
    );
  });
});
