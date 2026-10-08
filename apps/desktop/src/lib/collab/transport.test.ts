import { RequestError } from "@lmms-lab/sync";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Event = { payload: Record<string, unknown> };
const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let emit: (event: Event) => void = () => {};
let connected: (id: number) => void = () => {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, handler: (event: Event) => void) => {
    emit = handler;
    return () => {
      emit = () => {};
    };
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "collab_connect") return new Promise((resolve) => (connected = resolve));
    if (command === "collab_request")
      return Promise.reject(JSON.stringify({ status: 401, message: "登录已过期" }));
    return Promise.resolve(null);
  },
}));

const { desktopTransport } = await import("./transport");
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
});

describe("desktopTransport", () => {
  it("keeps messages that arrive before the socket id, and sends what was queued", async () => {
    const messages: string[] = [];
    const closes: Array<[number, string]> = [];
    const socket = desktopTransport("https://w.example").connect("/api/projects/p/socket?sync=1", {
      message: (data) => messages.push(data),
      close: (code, reason) => closes.push([code, reason]),
    });
    socket.send("early");
    await tick();
    emit({ payload: { id: 4, kind: "message", data: "ready", code: null, reason: null } });
    emit({ payload: { id: 9, kind: "message", data: "someone else's", code: null, reason: null } });
    connected(4);
    await tick();
    expect(messages).toEqual(["ready"]);
    expect(calls.find((c) => c.command === "collab_send")?.args).toEqual({ id: 4, data: "early" });
    emit({ payload: { id: 4, kind: "close", data: null, code: 1008, reason: "revoked" } });
    expect(closes).toEqual([[1008, "revoked"]]);
  });

  it("turns Rust's JSON errors into RequestError with the HTTP status", async () => {
    const error = await desktopTransport("https://w.example")
      .request("GET", "/api/me")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).status).toBe(401);
  });
});
