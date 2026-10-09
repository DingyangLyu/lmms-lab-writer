import { describe, expect, it, vi } from "vitest";
import {
  type ChatDraft,
  ChatOutbox,
  type OutboxSnapshot,
  type OutboxStorage,
  type QueuedMessage,
} from "./outbox";

const draft = (raw: string): ChatDraft => ({ raw, files: [], selection: null });
function memory(seed: OutboxSnapshot | null = null): OutboxStorage {
  let saved = seed;
  return {
    load: async () => structuredClone(saved),
    save: async (_key, value) => {
      saved = structuredClone(value);
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("conversation outbox", () => {
  it("sends FIFO only after completion boundaries and survives unrelated rerenders", async () => {
    const send = vi.fn(async (_message: QueuedMessage) => {}),
      q = new ChatOutbox("session-a", memory(), send);
    await q.load();
    q.update({ ready: true, busy: true, completion: 0 });
    await q.enqueue(draft("first"));
    await q.enqueue(draft("second"));
    expect(send).not.toHaveBeenCalled();
    q.update({ ready: true, busy: false, completion: 1 });
    await tick();
    expect(send.mock.calls.map((c) => c[0])).toHaveLength(1);
    expect(q.state.items[0]?.raw).toBe("second");
    for (let i = 0; i < 4; i++) q.update({ ready: true, busy: false, completion: 1 });
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    q.update({ ready: true, busy: false, completion: 2 });
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(q.state.items).toEqual([]);
  });
  it("pauses on stop/failure and never removes an unacknowledged message", async () => {
    const send = vi.fn(async (_message: QueuedMessage) => {
        throw new Error("disconnected");
      }),
      q = new ChatOutbox("a", memory(), send);
    await q.load();
    q.update({ ready: true, busy: true, completion: 0 });
    await q.enqueue(draft("preserve"));
    await q.enqueue(draft("later"));
    await q.pause("stopped");
    q.update({ ready: true, busy: false, completion: 1 });
    await tick();
    expect(send).not.toHaveBeenCalled();
    await q.resume();
    await tick();
    expect(q.state.paused).toBe(true);
    expect(q.state.items.map((i) => i.raw)).toEqual(["preserve", "later"]);
    expect(q.state.items[0]?.state).toBe("uncertain");
  });
  it("recovers pending deliveries paused and retains image and selection snapshots", async () => {
    const storage = memory();
    const q = new ChatOutbox("a", storage, async () => {});
    await q.load();
    const message = draft("original");
    message.files = [
      { url: "data:image/png;base64,fixture", mime: "image/png", filename: "图.png" },
    ];
    await q.enqueue(message);
    message.raw = "edited draft";
    const restarted = new ChatOutbox("a", storage, async () => {});
    await restarted.load();
    expect(restarted.state.paused).toBe(true);
    expect(restarted.state.items[0]?.raw).toBe("original");
    expect(restarted.state.items[0]?.files[0]?.filename).toBe("图.png");
  });
  it("does not lose a completion that arrives before acknowledgement", async () => {
    let q: ChatOutbox;
    const send = vi.fn(async (_message: QueuedMessage) => {
      q.update({ ready: true, busy: false, completion: send.mock.calls.length });
    });
    q = new ChatOutbox("a", memory(), send);
    await q.load();
    q.update({ ready: false, busy: false, completion: 0 });
    await q.enqueue(draft("1"));
    await q.enqueue(draft("2"));
    q.update({ ready: true, busy: false, completion: 0 });
    await tick();
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(q.state.items).toEqual([]);
  });
  it("keeps input unqueued if durable storage fails", async () => {
    const storage = memory();
    storage.save = async () => {
      throw new Error("disk full");
    };
    const q = new ChatOutbox("a", storage, async () => {});
    await q.load();
    await expect(q.enqueue(draft("keep in composer"))).rejects.toThrow("disk full");
    expect(q.state.items).toEqual([]);
    expect(q.state.error).toContain("保存失败");
  });
  it("allows reordering/removing waiting messages without dispatching paused work", async () => {
    const q = new ChatOutbox("a", memory(), async () => {});
    await q.load();
    await q.enqueue(draft("one"));
    await q.enqueue(draft("two"));
    const id = q.state.items[1]?.id || "";
    await q.move(id, -1);
    expect(q.state.items.map((i) => i.raw)).toEqual(["two", "one"]);
    await q.remove(id);
    expect(q.state.items.map((i) => i.raw)).toEqual(["one"]);
  });
});
