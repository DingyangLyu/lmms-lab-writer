import { afterEach, describe, expect, it, vi } from "vitest";
import { runOpenCodePrompt } from "./run-prompt";

vi.mock("@/lib/timing", () => ({ sleep: () => Promise.resolve() }));

type Handler = (url: string, init: RequestInit) => unknown;
function serve(handler: Handler) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET" });
    const body = handler(url, init);
    return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 500 : 200 });
  });
  return calls;
}
const options = { port: 4100, directory: "/work/paper", prompt: "hi", timeoutMs: 1000 };

afterEach(() => vi.unstubAllGlobals());

describe("runOpenCodePrompt", () => {
  it("returns the text of an immediate reply and deletes the session", async () => {
    const calls = serve((url, init) =>
      url.includes("/message")
        ? { parts: [{ type: "text", text: "feat: add intro" }] }
        : init.method === "DELETE"
          ? {}
          : { id: "s1" },
    );
    await expect(runOpenCodePrompt(options)).resolves.toBe("feat: add intro");
    expect(calls[0]?.url).toBe("http://localhost:4100/session?directory=%2Fwork%2Fpaper");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("polls for the assistant reply to its own message", async () => {
    serve((url, init) => {
      if (!url.includes("/message")) return { id: "s1" };
      if (init.method === "POST") return { info: { id: "m1", role: "user" }, parts: [] };
      return [
        { info: { role: "assistant", parentID: "other" }, parts: [{ type: "text", text: "no" }] },
        { info: { role: "assistant", parentID: "m1" }, parts: [{ type: "text", text: "yes" }] },
      ];
    });
    await expect(runOpenCodePrompt(options)).resolves.toBe("yes");
  });

  it("surfaces assistant errors and HTTP failures", async () => {
    serve((url, init) => {
      if (!url.includes("/message")) return { id: "s1" };
      if (init.method === "POST") return { info: { id: "m1", role: "user" } };
      return { messages: [{ info: { role: "assistant", error: { data: { message: "quota" } } } }] };
    });
    await expect(runOpenCodePrompt(options)).rejects.toThrow("quota");
    serve(() => undefined);
    await expect(runOpenCodePrompt(options)).rejects.toThrow("创建 OpenCode 会话失败");
  });
});
