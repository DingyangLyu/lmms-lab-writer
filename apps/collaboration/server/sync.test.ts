import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { fixture } from "./test-fixture";

type SyncMessage = {
  type: string;
  file?: string;
  update?: string;
  id?: string;
  status?: number;
  message?: string;
  sync?: boolean;
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A desktop sync socket: bearer token, no Origin header. */
async function syncSocket(origin: string, project: string, token: string) {
  const ws = new WebSocket(
    `${origin.replace("http:", "ws:")}/api/projects/${project}/socket?sync=1`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const queue: SyncMessage[] = [];
  const waiters: Array<{ test: (m: SyncMessage) => boolean; resolve: (m: SyncMessage) => void }> =
    [];
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString()) as SyncMessage;
    const index = waiters.findIndex((w) => w.test(m));
    if (index >= 0) waiters.splice(index, 1)[0]?.resolve(m);
    else queue.push(m);
  });
  const next = (type: string, file?: string) => {
    const test = (m: SyncMessage) => m.type === type && (file === undefined || m.file === file);
    const index = queue.findIndex(test);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0] as SyncMessage);
    return new Promise<SyncMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`missing ${type} ${file ?? ""}`)), 3000);
      waiters.push({
        test,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };
  const send = (message: object) => ws.send(JSON.stringify(message));
  return { ws, next, send };
}

describe("desktop sign-in and folder sync", () => {
  it("issues named device tokens that work without a browser Origin and can be revoked", async () => {
    const f = await fixture();
    const origin = f.app.origin;
    const signIn = (password: string) =>
      fetch(`${origin}/api/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "owner", password, name: "Lab iMac" }),
      });
    expect((await signIn("wrong-password-0000")).status).toBe(401);
    const issued = (await (await signIn("test-password-1234")).json()) as {
      token: string;
      user: { name: string };
    };
    expect(issued.user.name).toBe("owner");
    const auth = { Authorization: `Bearer ${issued.token}` };
    // A bearer request needs no Origin, even for writes.
    const created = await fetch(`${origin}/api/projects/${f.project}/files`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes.tex", content: "from desktop" }),
    });
    expect(created.status).toBe(201);
    const devices = (await (await fetch(`${origin}/api/tokens`, { headers: auth })).json()) as {
      id: string;
      name: string;
    }[];
    expect(devices.map((d) => d.name)).toEqual(["Lab iMac"]);
    // Cookie requests still need the right Origin.
    expect(
      (
        await fetch(`${origin}/api/projects`, {
          method: "POST",
          headers: { Cookie: f.owner, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x" }),
        })
      ).status,
    ).toBe(403);
    await fetch(`${origin}/api/tokens/current`, { method: "DELETE", headers: auth });
    expect((await fetch(`${origin}/api/me`, { headers: auth })).status).toBe(401);
  });

  it("follows several documents on one socket and syncs with web editors both ways", async () => {
    const f = await fixture();
    const origin = f.app.origin;
    const token = (
      (await (
        await fetch(`${origin}/api/tokens`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "owner", password: "test-password-1234", name: "d" }),
        })
      ).json()) as { token: string }
    ).token;
    const file = async (path: string, content: string) =>
      (await f.call(`/projects/${f.project}/files`, { path, content }, f.owner)).data.id as string;
    const a = await file("a.tex", "alpha"),
      b = await file("b.tex", "beta");
    const figure = (
      await f.call(`/projects/${f.project}/files`, { path: "fig.png", base64: "AAAA" }, f.owner)
    ).data.id as string;

    const sync = await syncSocket(origin, f.project, token);
    expect((await sync.next("ready")).sync).toBe(true);
    const docs = new Map<string, Y.Doc>();
    for (const id of [a, b]) {
      sync.send({ type: "join", file: id });
      const joined = await sync.next("joined", id);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(joined.update ?? "", "base64"));
      docs.set(id, doc);
    }
    expect(docs.get(a)?.getText("content").toString()).toBe("alpha");

    // A web editor's keystrokes reach the sync socket, tagged with the document.
    const web = await f.peer(f.owner, a);
    web.send(
      "w1",
      web.capture(() => web.doc.getText("content").insert(5, " web")),
    );
    const relayed = await sync.next("update", a);
    Y.applyUpdate(docs.get(a) as Y.Doc, Buffer.from(relayed.update ?? "", "base64"));
    expect(docs.get(a)?.getText("content").toString()).toBe("alpha web");

    // And a desktop edit reaches web editors and the stored text.
    const docB = docs.get(b) as Y.Doc;
    const before = Y.encodeStateVector(docB);
    docB.getText("content").insert(4, " desktop");
    sync.send({
      type: "update",
      file: b,
      id: "d1",
      update: b64(Y.encodeStateAsUpdate(docB, before)),
    });
    expect((await sync.next("ack", b)).id).toBe("d1");
    const stored = await f.call(`/projects/${f.project}/files/${b}`, undefined, f.owner);
    expect(stored.data.content).toBe("beta desktop");

    // Rejoining with a state vector returns only what is missing.
    sync.send({ type: "leave", file: a });
    sync.send({ type: "join", file: a, vector: b64(Y.encodeStateVector(docs.get(a) as Y.Doc)) });
    const delta = await sync.next("joined", a);
    expect(Buffer.from(delta.update ?? "", "base64").length).toBeLessThan(10);

    // A problem with one document is reported for it; the socket stays usable.
    sync.send({ type: "join", file: figure });
    const rejected = await sync.next("rejected", figure);
    expect(rejected.status).toBe(400);
    sync.send({ type: "ping", file: a });
    await sync.next("pong");

    // Deleting a followed document tells the sync socket instead of closing it.
    await f.call(`/projects/${f.project}/files/${a}`, undefined, f.owner, "DELETE");
    expect((await sync.next("closed", a)).file).toBe(a);
    await sync.next("project-changed");
    sync.ws.terminate();
  });
});
