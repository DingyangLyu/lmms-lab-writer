import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type * as Y from "yjs";
import { fixture } from "./test-fixture";

const closing = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) =>
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
/** A cursor message for `clientID`, as the editor sends it. */
function cursor(doc: Y.Doc, clientID: number) {
  const awareness = new Awareness(doc);
  awareness.setLocalState({ cursor: null });
  const states = awareness.getStates();
  const mine = states.get(doc.clientID);
  states.delete(doc.clientID);
  states.set(clientID, mine ?? {});
  awareness.meta.set(clientID, awareness.meta.get(doc.clientID) ?? { clock: 1, lastUpdated: 0 });
  const update = Buffer.from(encodeAwarenessUpdate(awareness, [clientID])).toString("base64");
  awareness.destroy();
  return JSON.stringify({ type: "awareness", update });
}

describe("editor connections", () => {
  it("signing out closes only that sign-in's pages", async () => {
    const f = await fixture();
    const file = (
      await f.call(`/projects/${f.project}/files`, { path: "main.tex", content: "text" }, f.owner)
    ).data.id as string;
    const other = (await f.call("/login", { username: "owner", password: "test-password-1234" }))
      .cookie;
    const signingOut = await f.peer(f.owner, file),
      staying = await f.peer(other, file);
    const closed = closing(signingOut.ws);
    await f.call("/logout", {}, f.owner);
    expect(await closed).toEqual({ code: 1008, reason: "已退出登录" });
    // The other sign-in keeps editing.
    staying.send(
      "u1",
      staying.capture(() => staying.doc.getText("content").insert(0, "more ")),
    );
    expect((await staying.next("ack")).id).toBe("u1");
  });

  it("lets a reconnected page take over its cursor, but not someone else's", async () => {
    const f = await fixture();
    const editor = await f.invite("editor", "ed");
    const file = (
      await f.call(`/projects/${f.project}/files`, { path: "main.tex", content: "text" }, f.owner)
    ).data.id as string;
    const before = await f.peer(f.owner, file);
    const id = before.doc.clientID;
    before.ws.send(cursor(before.doc, id));
    // The same page again, its old connection not yet seen to drop.
    const stale = closing(before.ws);
    const after = await f.peer(f.owner, file);
    after.ws.send(cursor(after.doc, id));
    expect((await stale).code).toBe(1006);
    after.send(
      "u1",
      after.capture(() => after.doc.getText("content").insert(0, "x")),
    );
    expect((await after.next("ack")).id).toBe("u1");
    // Another account claiming that cursor is refused, and says why.
    const intruder = await f.peer(editor, file);
    const refused = closing(intruder.ws);
    intruder.ws.send(cursor(intruder.doc, id));
    expect(await refused).toEqual({ code: 1008, reason: "不能修改其他人的光标" });
  });

  it("drops connections that stop answering pings", async () => {
    const f = await fixture();
    const file = (
      await f.call(`/projects/${f.project}/files`, { path: "main.tex", content: "text" }, f.owner)
    ).data.id as string;
    const silent = new WebSocket(
      `${f.app.origin.replace("http:", "ws:")}/api/projects/${f.project}/socket?file=${file}`,
      { headers: { Cookie: f.owner, Origin: f.app.origin }, autoPong: false },
    );
    await new Promise((resolve) => silent.once("message", resolve));
    const answering = await f.peer(f.owner, file);
    const gone = closing(silent);
    f.app.collab.heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 200));
    f.app.collab.heartbeat();
    expect((await gone).code).toBe(1006);
    answering.send(
      "u1",
      answering.capture(() => answering.doc.getText("content").insert(0, "y")),
    );
    expect((await answering.next("ack")).id).toBe("u1");
  });
});
