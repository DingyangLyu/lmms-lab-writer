import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    whenSynced = Promise.resolve();
    destroy() {
      return Promise.resolve();
    }
  },
}));
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 1;
  sent: Array<{ type: string; id?: string; update?: string }> = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}
vi.stubGlobal("WebSocket", FakeSocket);
vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
vi.stubGlobal("location", { protocol: "http:", host: "localhost", origin: "http://localhost" });
const { WriterProvider } = await import("./provider");

afterEach(() => vi.useRealTimers());
describe("WriterProvider", () => {
  it("merges a burst of keystrokes into one durable update", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const provider = new WriterProvider(
      "p",
      "f",
      { id: "u", name: "U" },
      (s) => statuses.push(s),
      () => {},
      () => {},
    );
    await vi.waitFor(() => expect(FakeSocket.last).toBeDefined());
    const server = new Y.Doc();
    server.getText("content").insert(0, "base");
    const socket = FakeSocket.last;
    socket.onmessage?.({
      data: JSON.stringify({
        type: "ready",
        role: "editor",
        state: Buffer.from(Y.encodeStateAsUpdate(server)).toString("base64"),
      }),
    });
    const text = provider.doc.getText("content");
    for (const c of "abc") text.insert(text.length, c);
    expect(socket.sent.filter((m) => m.type === "update")).toHaveLength(0);
    vi.advanceTimersByTime(100);
    const updates = socket.sent.filter((m) => m.type === "update");
    expect(updates).toHaveLength(1);
    Y.applyUpdate(server, Buffer.from(updates[0]?.update ?? "", "base64"));
    expect(server.getText("content").toString()).toBe("baseabc");
    socket.onmessage?.({ data: JSON.stringify({ type: "ack", id: updates[0]?.id }) });
    expect(statuses.at(-1)).toBe("saved");
    provider.destroy();
    server.destroy();
  });
});
