import { afterEach, expect, it, vi } from "vitest";
import { openEventStream } from "./event-stream";

class FakeSource {
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeSource[] = [];
  readyState = 1;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    FakeSource.instances.push(this);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  FakeSource.instances = [];
});
it("shares a socket across eight conversations and detaches only the closed subscriber", async () => {
  vi.stubGlobal("EventSource", FakeSource);
  const clients = Array.from({ length: 8 }, () => openEventStream("http://qa/event"));
  const callbacks = clients.map((client) => {
    const callback = vi.fn();
    client.onmessage = callback;
    return callback;
  });
  expect(FakeSource.instances).toHaveLength(1);
  clients[0]?.close();
  FakeSource.instances[0]?.onmessage?.(new MessageEvent("message", { data: "update" }));
  expect(callbacks[0]).not.toHaveBeenCalled();
  for (const callback of callbacks.slice(1)) expect(callback).toHaveBeenCalledTimes(1);
  expect(FakeSource.instances[0]?.close).not.toHaveBeenCalled();
  for (const client of clients.slice(1)) client.close();
  expect(FakeSource.instances[0]?.close).toHaveBeenCalledOnce();
  await Promise.resolve();
});
it("isolates projects and signals already-open streams to late subscribers", async () => {
  vi.stubGlobal("EventSource", FakeSource);
  const a = openEventStream("http://qa/event?directory=a");
  const b = openEventStream("http://qa/event?directory=b");
  const late = openEventStream("http://qa/event?directory=a");
  late.onopen = vi.fn();
  await Promise.resolve();
  expect(FakeSource.instances).toHaveLength(2);
  expect(late.onopen).toHaveBeenCalledOnce();
  a.close();
  b.close();
  late.close();
});

it("reconnects a permanently closed shared source without old subscribers deleting the replacement", () => {
  vi.stubGlobal("EventSource", FakeSource);
  const a = openEventStream("http://qa/reconnect"),
    b = openEventStream("http://qa/reconnect");
  const source = FakeSource.instances[0];
  if (!source) throw new Error("Missing source");
  source.readyState = FakeSource.CLOSED;
  a.close();
  const c = openEventStream("http://qa/reconnect");
  b.close();
  const d = openEventStream("http://qa/reconnect");
  expect(FakeSource.instances).toHaveLength(2);
  c.close();
  d.close();
  d.close();
  expect(FakeSource.instances[1]?.close).toHaveBeenCalledOnce();
});
