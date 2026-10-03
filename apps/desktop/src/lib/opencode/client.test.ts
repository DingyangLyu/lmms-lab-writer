import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeClient } from "./client";
import type { Event, ReasoningPart, TextPart } from "./types";

class MockEventSource {
  static latest: MockEventSource;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    MockEventSource.latest = this;
  }
  close() {}
  emit(event: Event) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("persists renamed sessions through PATCH and leaves the title unchanged on failure", async () => {
  const session = { id: "ses_test", title: "中文论文", time: { created: 1, updated: 2 } };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(session))
    .mockResolvedValueOnce(new Response("failed", { status: 500 }));
  vi.stubGlobal("fetch", fetch);
  const client = new OpenCodeClient({ baseUrl: "http://localhost:4096", directory: "/tmp/paper" });
  await client.renameSession("ses_test", " 中文论文 ");
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "PATCH",
    body: JSON.stringify({ title: "中文论文" }),
  });
  expect(client.store.sessions.get("ses_test")?.title).toBe("中文论文");
  await expect(client.renameSession("ses_test", "Failed rename")).rejects.toThrow();
  expect(client.store.sessions.get("ses_test")?.title).toBe("中文论文");
});

describe("OpenCode client compatibility", () => {
  it("bounds in-memory message and part history when switching sessions", () => {
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    for (let i = 0; i < 12; i++) {
      client.store.messages.set(`session-${i}`, [
        { id: `message-${i}`, sessionID: `session-${i}`, role: "user" } as never,
      ]);
      client.store.parts.set(`session-${i}:message-${i}`, []);
      (client as unknown as { touchSession: (id: string) => void }).touchSession(`session-${i}`);
    }
    expect(client.store.messages.size).toBeLessThanOrEqual(8);
    expect(
      [...client.store.parts.keys()].every((key) =>
        client.store.messages.has(key.split(":")[0] ?? ""),
      ),
    ).toBe(true);
  });
  it("renders text and reasoning deltas without duplicating the final snapshot", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    client.connect();
    const source = MockEventSource.latest;
    for (const type of ["text", "reasoning"] as const) {
      const part: TextPart | ReasoningPart = {
        id: type,
        sessionID: "s",
        messageID: "m",
        type,
        text: "",
      };
      source.emit({ type: "message.part.updated", properties: { part } });
      for (const delta of ["清晨", "的图书馆"]) {
        source.emit({
          type: "message.part.delta",
          properties: {
            sessionID: "s",
            messageID: "m",
            partID: type,
            field: "text",
            delta,
          },
        });
      }
      expect(client.store.parts.get("s:m")?.find((p) => p.id === type)).toMatchObject({
        text: "清晨的图书馆",
      });
      source.emit({
        type: "message.part.updated",
        properties: { part: { ...part, text: "清晨的图书馆" } },
      });
      expect(client.store.parts.get("s:m")?.find((p) => p.id === type)).toMatchObject({
        text: "清晨的图书馆",
      });
    }
    client.disconnect();
  });
  it("excludes hidden agents and subagents from the primary picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json([
          { name: "build", mode: "primary" },
          { name: "title", mode: "primary", hidden: true },
          { name: "explore", mode: "subagent" },
          { name: "writer", mode: "all" },
        ]),
      ),
    );
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    expect((await client.getAgents()).map((agent) => agent.id)).toEqual(["build", "writer"]);
  });
  it("loads only model defaults from config with the project directory", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        model: "anthropic/k3",
        default_agent: "build",
        provider: { sensitive: "not retained" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096", directory: "/tmp/中文" });
    expect(await client.getConfig()).toEqual({ model: "anthropic/k3", default_agent: "build" });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:4096/config?directory=%2Ftmp%2F%E4%B8%AD%E6%96%87",
    );
  });
  it("does not treat a JSON server error as a ready API", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 })),
    );
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const ready = client.waitForApiReady(1, 1);
    await vi.runAllTimersAsync();
    expect(await ready).toBe(false);
    vi.restoreAllMocks();
  });
});

it("sends image bytes with an image-only message instead of dropping attachments", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetch);
  const client = new OpenCodeClient({ baseUrl: "http://localhost:4096", directory: "/tmp/paper" });
  const file = { url: "data:image/png;base64,fixture", mime: "image/png", filename: "图.png" };
  await client.chat("test-session", "", {
    model: { providerID: "anthropic", modelID: "k3" },
    files: [file],
  });
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
    model: { providerID: "anthropic", modelID: "k3" },
    parts: [{ type: "file", ...file }],
  });
});

it("restores a running session and does not overwrite a later SSE completion with a stale HTTP snapshot", async () => {
  vi.stubGlobal("EventSource", MockEventSource);
  const client = new OpenCodeClient({ baseUrl: "http://localhost:4096", directory: "/tmp/paper" });
  client.connect();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ s: { type: "busy" } })));
  expect(await client.getSessionStatus("s")).toEqual({ type: "busy" });
  let resolve: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  const pending = client.getSessionStatus("s");
  MockEventSource.latest.emit({
    type: "session.status",
    properties: { sessionID: "s", status: { type: "idle" } },
  });
  resolve?.(Response.json({ s: { type: "busy" } }));
  expect(await pending).toEqual({ type: "idle" });
  client.disconnect();
});

it("history filters truly empty sessions using one message, including image-only conversations", async () => {
  const sessions = ["empty", "images", "text"].map((id) => ({
    id,
    title: id,
    time: { created: 1, updated: 2 },
  }));
  const fetch = vi.fn(async (url: string) =>
    url.includes("/message")
      ? Response.json(
          url.includes("/empty/")
            ? []
            : [
                {
                  info: { role: "user" },
                  parts: url.includes("/images/")
                    ? [{ type: "file", mime: "image/png" }]
                    : [{ type: "text", text: "Hi" }],
                },
              ],
        )
      : Response.json(sessions),
  );
  vi.stubGlobal("fetch", fetch);
  const client = new OpenCodeClient({ baseUrl: "http://localhost:4096", directory: "/tmp/paper" });
  expect((await client.listHistorySessions()).map((s) => s.id)).toEqual(["images", "text"]);
  expect(
    fetch.mock.calls
      .filter(([url]) => url.includes("/message"))
      .every(([url]) => url.endsWith("&limit=1")),
  ).toBe(true);
  expect(fetch.mock.calls.some(([url]) => url.includes("prompt"))).toBe(false);
});
it("history reports connection failures instead of claiming all conversations vanished", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
  const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
  await expect(client.listHistorySessions()).rejects.toThrow("503");
});
