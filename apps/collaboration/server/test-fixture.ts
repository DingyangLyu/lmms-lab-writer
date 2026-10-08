/** Test server on PGlite (or WRITER_TEST_DATABASE_URL) with signed-in helpers. */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { createWriterServer, type Options } from "./app";

export type Message = {
  type: string;
  state?: string;
  update?: string;
  id?: string;
  message?: string;
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
/** PGlite by default; set WRITER_TEST_DATABASE_URL to run against a real PostgreSQL server. */
export async function database(dir: string) {
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
export async function fixture(options: Partial<Options> = {}) {
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
