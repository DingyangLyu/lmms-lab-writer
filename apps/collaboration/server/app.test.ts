import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as encoding from "lib0/encoding";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { createWriterServer, type Options } from "./app";
import { sql } from "./db";
import { AUTOMATIC_SNAPSHOTS } from "./store";

type Message = { type: string; state?: string; update?: string; id?: string; message?: string };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
/** PGlite by default; set WRITER_TEST_DATABASE_URL to run against a real PostgreSQL server. */
async function database(dir: string) {
  const server = process.env.WRITER_TEST_DATABASE_URL;
  if (!server) return { url: `pglite:${join(dir, "pg")}`, drop: async () => {} };
  const name = `writer_test_${randomBytes(6).toString("hex")}`;
  const admin = async (statement: string) => {
    const client = new pg.Client({ connectionString: server });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };
  await admin(`CREATE DATABASE ${name}`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) };
}
async function fixture(options: Partial<Options> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "writer-collab-test-"));
  const db = await database(dir);
  let app = await createWriterServer({
    databaseUrl: db.url,
    port: 0,
    adminUser: "owner",
    adminPassword: "test-password-1234",
    ...options,
  });
  cleanups.push(async () => {
    await app.close();
    await db.drop();
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
    app = await createWriterServer({ databaseUrl: db.url, port: 0 });
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
  it("rate-limits sign-in per client, trusting X-Forwarded-For only behind a proxy", async () => {
    const attempt = async (f: Awaited<ReturnType<typeof fixture>>, forwardedFor: string) =>
      (
        await fetch(`${f.app.origin}/api/login`, {
          method: "POST",
          headers: {
            Origin: f.app.origin,
            "Content-Type": "application/json",
            "X-Forwarded-For": forwardedFor,
          },
          body: JSON.stringify({ username: "owner", password: "wrong-password-0000" }),
        })
      ).status;
    const proxied = await fixture({ trustProxy: true });
    // The proxy appends the address it saw; a client-supplied first entry does not pick the bucket.
    for (let i = 0; i < 12; i++)
      expect(await attempt(proxied, "198.51.100.7, 203.0.113.5")).toBe(401);
    expect(await attempt(proxied, "203.0.113.5")).toBe(429);
    expect(await attempt(proxied, "203.0.113.6")).toBe(401);
    const direct = await fixture();
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) statuses.push(await attempt(direct, `203.0.113.${i}`));
    expect(statuses).toContain(429);
  });
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
  it("skips tasks that can no longer run and follows renamed files", async () => {
    const f = await fixture(),
      editor = await f.invite("editor", "temporary");
    const files = `/projects/${f.project}/files`;
    const file = (await f.call(files, { path: "main.tex", content: "Old.\n" }, f.owner)).data.id;
    const token = (
      await f.call(
        `/projects/${f.project}/runners`,
        { name: "worker", capabilities: ["codex"] },
        f.owner,
      )
    ).data.token;
    const runner = async (path: string, body: unknown) => {
      const response = await fetch(`${f.app.origin}/api/runner/${path}`, {
        method: "POST",
        headers: { Origin: f.app.origin, Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    const orphan = (
      await f.call(`/projects/${f.project}/jobs`, { harness: "codex", prompt: "a" }, editor)
    ).data.id;
    const kept = (
      await f.call(`/projects/${f.project}/jobs`, { harness: "codex", prompt: "b" }, f.owner)
    ).data.id;
    const me = (await f.call("/me", undefined, editor)).data.id;
    await f.call(`/projects/${f.project}/members/${me}`, {}, f.owner, "DELETE");
    const leased = await runner("lease", {});
    expect(leased.status).toBe(200);
    expect(leased.data.job.id).toBe(kept);
    const jobs = (await f.call(`/projects/${f.project}/jobs`, undefined, f.owner)).data;
    expect(jobs.find((j: { id: string }) => j.id === orphan).status).toBe("failed");
    await f.call(`${files}/${file}`, { path: "chapter.tex" }, f.owner, "PATCH");
    const done = await runner("result", {
      id: kept,
      result: "ok",
      files: [{ path: "main.tex", content: "New.\n" }],
    });
    expect(done.status).toBe(200);
    const listed = (await f.call(files, undefined, f.owner)).data;
    expect(listed.map((x: { path: string }) => x.path)).toEqual(["chapter.tex"]);
    const proposals = (await f.call(`/projects/${f.project}/proposals`, undefined, f.owner)).data;
    expect(proposals[0].file).toBe(file);
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
  it("survives malformed cursor updates and keeps per-user cursor identity", async () => {
    const f = await fixture(),
      viewer = await f.invite("viewer", "reader");
    const file = (
      await f.call(`/projects/${f.project}/files`, { path: "main.tex", content: "text" }, f.owner)
    ).data.id;
    const owner = await f.peer(f.owner, file),
      bad = await f.peer(viewer, file);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 2);
    encoding.writeVarUint(encoder, 4242);
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarString(encoder, JSON.stringify({ cursor: null }));
    encoding.writeVarUint(encoder, 4343);
    const closed = new Promise<number>((resolve) => bad.ws.once("close", resolve));
    bad.ws.send(
      JSON.stringify({
        type: "awareness",
        update: Buffer.from(encoding.toUint8Array(encoder)).toString("base64"),
      }),
    );
    expect(await closed).toBe(1008);
    expect((await f.call("/health")).status).toBe(200);
    const awareness = new Awareness(owner.doc);
    awareness.setLocalStateField("user", { name: "spoofed", color: "#000" });
    owner.ws.send(
      JSON.stringify({
        type: "awareness",
        update: Buffer.from(encodeAwarenessUpdate(awareness, [owner.doc.clientID])).toString(
          "base64",
        ),
      }),
    );
    const watcher = await f.peer(f.owner, file),
      seen = new Awareness(watcher.doc);
    applyAwarenessUpdate(
      seen,
      Buffer.from((await watcher.next("awareness")).update || "", "base64"),
      null,
    );
    const user = seen.getStates().get(owner.doc.clientID)?.user as { name: string; color: string };
    expect(user.name).toBe("owner");
    expect(user.color).toMatch(/^hsl\(/);
    awareness.destroy();
    seen.destroy();
  });
  it("releases rooms after rejected replacements and keeps the audit trail readable", async () => {
    const f = await fixture();
    const file = (
      await f.call(`/projects/${f.project}/files`, { path: "a.tex", content: "one" }, f.owner)
    ).data.id;
    const stale = await f.call(
      `/projects/${f.project}/files/${file}`,
      { expected: "stale", content: "two" },
      f.owner,
      "PUT",
    );
    expect(stale.status).toBe(409);
    expect(f.app.collab.rooms.size).toBe(0);
    const p = await f.peer(f.owner, file);
    for (const [i, text] of ["x", "y", "z"].entries()) {
      p.send(
        `e${i}`,
        p.capture(() => p.doc.getText("content").insert(0, text)),
      );
      await p.next("ack");
    }
    const edits = (await f.call(`/projects/${f.project}/audit`, undefined, f.owner)).data.filter(
      (a: { action: string }) => a.action === "document.edit",
    );
    expect(edits).toHaveLength(1);
    expect(
      (await f.call(`/projects/${f.project}/files/${file}`, undefined, f.owner)).data.content,
    ).toBe("zyxone");
  });
  it("reuses deleted paths, guards renames and reports input errors as client errors", async () => {
    const f = await fixture(),
      files = `/projects/${f.project}/files`;
    const first = (await f.call(files, { path: "main.tex", content: "v1" }, f.owner)).data.id;
    expect((await f.call(`${files}/${first}`, {}, f.owner, "DELETE")).status).toBe(200);
    const second = await f.call(files, { path: "main.tex", content: "v2" }, f.owner);
    expect(second.status).toBe(201);
    expect((await f.call(files, { path: "main.tex", content: "v3" }, f.owner)).status).toBe(409);
    const other = (await f.call(files, { path: "notes.tex", content: "n" }, f.owner)).data.id;
    expect((await f.call(`${files}/${other}`, { path: "main.tex" }, f.owner, "PATCH")).status).toBe(
      409,
    );
    expect(
      (await f.call(`${files}/${other}`, { path: "figure.png" }, f.owner, "PATCH")).status,
    ).toBe(400);
    await f.call(`${files}/${second.data.id}`, {}, f.owner, "DELETE");
    expect((await f.call(`${files}/${other}`, { path: "main.tex" }, f.owner, "PATCH")).status).toBe(
      200,
    );
    const listed = (await f.call(files, undefined, f.owner)).data;
    expect(listed.map((x: { path: string }) => x.path)).toEqual(["main.tex"]);
    const bad = await f.call(
      `/projects/${f.project}/bibliography/rename`,
      { from: "a", to: "bad key" },
      f.owner,
    );
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("引用键");
    expect((await f.call(`/projects/${f.project}/doi`, { doi: "nope" }, f.owner)).status).toBe(400);
    const audit = (await f.call(`/projects/${f.project}/audit`, undefined, f.owner)).data;
    expect(audit.some((a: { action: string }) => a.action === "file.delete")).toBe(true);
  });
  it("bounds automatic versions without touching manual ones or queued task inputs", async () => {
    const f = await fixture(),
      me = (await f.call("/me", undefined, f.owner)).data.id as string;
    const manual = await f.call(`/projects/${f.project}/snapshots`, {}, f.owner);
    expect(manual.status).toBe(201);
    const job = (
      await f.call(`/projects/${f.project}/jobs`, { harness: "codex", prompt: "x" }, f.owner)
    ).data.id;
    for (let i = 0; i < AUTOMATIC_SNAPSHOTS + 5; i++)
      await f.app.store.snapshot(f.project, me, `auto ${i}`);
    const rows = await f.app.store.db.rows<{ id: string; label: string; manual: boolean }>(
      sql`SELECT id, label, manual FROM snapshots WHERE project=${f.project}`,
    );
    expect(rows.filter((r) => !r.manual)).toHaveLength(AUTOMATIC_SNAPSHOTS + 1);
    expect(rows.find((r) => r.id === manual.data.id)?.label).toBe("手动版本");
    const base = (
      await f.app.store.db.row<{ base: string }>(sql`SELECT base FROM jobs WHERE id=${job}`)
    )?.base;
    expect(rows.some((r) => r.id === base)).toBe(true);
  });
  it("appends edits incrementally and compacts them when the last editor leaves", async () => {
    const f = await fixture();
    const file = (
      await f.call(`/projects/${f.project}/files`, { path: "a.tex", content: "base" }, f.owner)
    ).data.id;
    const count = async () =>
      (
        await f.app.store.db.row<{ n: number }>(
          sql`SELECT count(*) AS n FROM file_updates WHERE file=${file}`,
        )
      )?.n;
    const p = await f.peer(f.owner, file);
    for (const [i, text] of ["1", "2", "3"].entries()) {
      p.send(
        `u${i}`,
        p.capture(() => p.doc.getText("content").insert(0, text)),
      );
      await p.next("ack");
    }
    expect(await count()).toBe(3);
    // Readers see appended edits before compaction.
    expect(
      (await f.call(`/projects/${f.project}/files/${file}`, undefined, f.owner)).data.content,
    ).toBe("321base");
    p.ws.close();
    for (let i = 0; i < 100 && (await count()) !== 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(await count()).toBe(0);
    expect(
      (await f.call(`/projects/${f.project}/files/${file}`, undefined, f.owner)).data.content,
    ).toBe("321base");
  });
  it("never leases one task twice or applies two decisions on the same revision", async () => {
    const f = await fixture();
    const files = `/projects/${f.project}/files`;
    const file = (await f.call(files, { path: "m.tex", content: "a\nb\n" }, f.owner)).data.id;
    const token = (
      await f.call(
        `/projects/${f.project}/runners`,
        { name: "w", capabilities: ["codex"] },
        f.owner,
      )
    ).data.token;
    for (const prompt of ["one", "two"])
      await f.call(`/projects/${f.project}/jobs`, { harness: "codex", prompt }, f.owner);
    const lease = () =>
      fetch(`${f.app.origin}/api/runner/lease`, {
        method: "POST",
        headers: { Origin: f.app.origin, Authorization: `Bearer ${token}` },
        body: "{}",
      }).then((r) => r.json());
    const leased = await Promise.all([lease(), lease(), lease()]);
    const ids = leased.map((l) => l.job?.id).filter(Boolean);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const proposal = (
      await f.call(
        `/projects/${f.project}/proposals`,
        { file, base: "a\nb\n", proposed: "A\nb\n" },
        f.owner,
      )
    ).data.id;
    const decide = (status: string) =>
      f.call(
        `/projects/${f.project}/proposals/${proposal}/decide`,
        { revision: 1, part: 0, status },
        f.owner,
      );
    const results = await Promise.all([decide("accepted"), decide("rejected")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const content = (await f.call(`${files}/${file}`, undefined, f.owner)).data.content;
    expect(["A\nb\n", "a\nb\n"]).toContain(content);
  });
  it("lets administrators manage accounts with one-time passwords", async () => {
    const f = await fixture();
    const created = await f.call("/admin/users", { username: "student" }, f.owner);
    expect(created.status).toBe(200);
    const temporary = created.data.password as string;
    expect(temporary.length).toBeGreaterThanOrEqual(12);
    const first = await f.call("/login", { username: "student", password: temporary });
    expect(first.data.mustChange).toBe(true);
    expect((await f.call("/projects", undefined, first.cookie)).status).toBe(403);
    expect((await f.call("/admin/users", undefined, first.cookie)).status).toBe(403);
    expect(
      (await f.call("/me/password", { current: "wrong", next: "student-password-1" }, first.cookie))
        .status,
    ).toBe(403);
    const changed = await f.call(
      "/me/password",
      { current: temporary, next: "student-password-1" },
      first.cookie,
    );
    expect(changed.status).toBe(200);
    // The old session is gone; the response carries a fresh one.
    expect((await f.call("/projects", undefined, first.cookie)).status).toBe(401);
    expect((await f.call("/projects", undefined, changed.cookie)).status).toBe(200);
    expect((await f.call("/login", { username: "student", password: temporary })).status).toBe(401);
    const id = (await f.call("/me", undefined, changed.cookie)).data.id;
    const reset = await f.call(`/admin/users/${id}/reset`, {}, f.owner);
    expect((await f.call("/projects", undefined, changed.cookie)).status).toBe(401);
    expect(
      (await f.call("/login", { username: "student", password: reset.data.password })).data
        .mustChange,
    ).toBe(true);
    expect((await f.call(`/admin/users/${id}`, { disabled: true }, f.owner, "PATCH")).status).toBe(
      200,
    );
    expect(
      (await f.call("/login", { username: "student", password: reset.data.password })).status,
    ).toBe(403);
    const me = (await f.call("/me", undefined, f.owner)).data.id;
    expect((await f.call(`/admin/users/${me}`, { admin: false }, f.owner, "PATCH")).status).toBe(
      400,
    );
    const users = (await f.call("/admin/users", undefined, f.owner)).data;
    expect(users.find((u: { id: string }) => u.id === id)).toMatchObject({
      disabled: true,
      mustChange: true,
    });
    expect((await f.call("/admin/users", { username: "student" }, f.owner)).status).toBe(409);
  });
  it("changes member roles live and deletes projects only with confirmation", async () => {
    const f = await fixture(),
      editor = await f.invite("editor", "coauthor");
    const file = (
      await f.call(`/projects/${f.project}/files`, { path: "m.tex", content: "x" }, f.owner)
    ).data.id;
    const peer = await f.peer(editor, file);
    const closed = new Promise<number>((resolve) => peer.ws.once("close", resolve));
    const editorId = (await f.call("/me", undefined, editor)).data.id;
    const ownerId = (await f.call("/me", undefined, f.owner)).data.id;
    expect(
      (
        await f.call(
          `/projects/${f.project}/members/${editorId}`,
          { role: "viewer" },
          f.owner,
          "PATCH",
        )
      ).status,
    ).toBe(200);
    expect(await closed).toBe(4001);
    expect(
      (await f.call(`/projects/${f.project}/files`, { path: "n.tex", content: "" }, editor)).status,
    ).toBe(403);
    expect(
      (
        await f.call(
          `/projects/${f.project}/members/${ownerId}`,
          { role: "editor" },
          f.owner,
          "PATCH",
        )
      ).status,
    ).toBe(409);
    expect(
      (await f.call(`/projects/${f.project}`, { name: "改名后" }, f.owner, "PATCH")).status,
    ).toBe(200);
    expect((await f.call(`/projects/${f.project}`, undefined, f.owner)).data.name).toBe("改名后");
    expect(
      (await f.call(`/projects/${f.project}`, { confirm: "test-paper" }, f.owner, "DELETE")).status,
    ).toBe(400);
    expect(
      (await f.call(`/projects/${f.project}`, { confirm: "改名后" }, editor, "DELETE")).status,
    ).toBe(403);
    expect(
      (await f.call(`/projects/${f.project}`, { confirm: "改名后" }, f.owner, "DELETE")).status,
    ).toBe(200);
    expect((await f.call(`/projects/${f.project}`, undefined, f.owner)).status).toBe(403);
    expect((await f.call("/projects", undefined, f.owner)).data).toEqual([]);
  });
  it("serves built module scripts as JavaScript so the pdf.js worker can load", async () => {
    const assets = await readdir(join(import.meta.dirname, "../dist/assets")).catch(() => []);
    const mjs = assets.find((name) => name.endsWith(".mjs"));
    if (!mjs) return; // Client not built (pnpm build); nothing to serve.
    const f = await fixture();
    const response = await fetch(`${f.app.origin}/assets/${mjs}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
  });
  it("compares a saved version with the current project", async () => {
    const f = await fixture(),
      files = `/projects/${f.project}/files`;
    const create = async (path: string, content: string) =>
      (await f.call(files, { path, content }, f.owner)).data.id as string;
    const edited = await create("a.tex", "one\n"),
      renamed = await create("b.tex", "same\n"),
      removed = await create("c.tex", "gone\n");
    const version = (await f.call(`/projects/${f.project}/snapshots`, { label: "v1" }, f.owner))
      .data.id;
    await f.call(`${files}/${edited}`, { expected: "one\n", content: "two\n" }, f.owner, "PUT");
    await f.call(`${files}/${renamed}`, { path: "chapters/b.tex" }, f.owner, "PATCH");
    await f.call(`${files}/${removed}`, {}, f.owner, "DELETE");
    const added = await create("d.tex", "new\n");
    const changes = (
      await f.call(`/projects/${f.project}/snapshots/${version}/changes`, undefined, f.owner)
    ).data as Array<{ id: string; status: string; oldPath?: string }>;
    const status = Object.fromEntries(changes.map((c) => [c.id, c.status]));
    expect(status).toEqual({
      [edited]: "changed",
      [renamed]: "renamed",
      [removed]: "removed",
      [added]: "added",
    });
    expect(changes.find((c) => c.id === renamed)?.oldPath).toBe("b.tex");
    expect(
      (
        await f.call(
          `/projects/${f.project}/snapshots/${version}/files/${edited}`,
          undefined,
          f.owner,
        )
      ).data.content,
    ).toBe("one\n");
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
    expect(notes[0].resolved).toBe(true);
    expect(notes[0].replies[0].body).toBe("已核对");
    // Comments are additive; they no longer copy the whole project into a version each time.
    expect((await f.call(`/projects/${f.project}/snapshots`, undefined, f.owner)).data).toEqual([]);
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
