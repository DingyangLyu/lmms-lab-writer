import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The Writer tools' MCP server, against a runner endpoint that answers from `answer`. */
async function bridge(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const asked: Array<{ method: string; params: Record<string, unknown>; key: unknown }> = [];
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { method, params } = JSON.parse(body);
    asked.push({ method, params, key: req.headers["x-writer-bridge"] });
    res.writeHead(200, { "Content-Type": "application/json" });
    try {
      res.end(JSON.stringify({ result: answer(method, params) }));
    } catch (error) {
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  const child = spawn(process.execPath, [join(import.meta.dirname, "writer-bridge.mjs")], {
    env: { ...process.env, WRITER_BRIDGE_URL: `http://127.0.0.1:${port}/`, WRITER_BRIDGE_KEY: "k" },
  });
  cleanups.push(() => {
    child.kill();
    http.close();
  });
  const replies = new Map<number, (m: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
  });
  let next = 0;
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      replies.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await rpc("tools/call", { name, arguments: args })).result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: result.content[0]?.text ?? "", error: !!result.isError };
  };
  return { rpc, call, asked };
}

describe("the Writer tools of the runner's agents", () => {
  it("lists its tools and forwards each call with the conversation's bare ID", async () => {
    const b = await bridge((method, params) => {
      if (method === "list")
        return [
          {
            id: "a1",
            harness: "codex",
            title: "Intro",
            owner: "ana",
            updated: 0,
            you: true,
            available: true,
          },
          {
            id: "b2",
            harness: "claude",
            title: null,
            owner: "bo",
            updated: 0,
            running: false,
            available: false,
          },
        ];
      if (method === "read")
        return { id: params.target, harness: "claude", title: null, text: "USER: hi" };
      if (method === "delegate") return { task: "t1", status: "queued" };
      throw new Error("Only the conversation whose turn is running can use the Writer tools");
    });
    const init = (await b.rpc("initialize", { protocolVersion: "2025-06-18" })).result as {
      serverInfo: { name: string };
    };
    expect(init.serverInfo.name).toBe("writer");
    const tools = ((await b.rpc("tools/list")).result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "writer_list_conversations",
      "writer_read_conversation",
      "writer_delegate",
      "writer_get_task",
    ]);
    const listed = await b.call("writer_list_conversations", {
      conversation_id: "[Writer conversation ID: codex:a1]",
    });
    expect(listed.text).toContain("codex:a1  ← you");
    expect(listed.text).toContain("claude:b2 (not offered by the runner now)");
    expect(
      (
        await b.call("writer_read_conversation", {
          conversation_id: "codex:a1",
          target_id: "claude:b2",
        })
      ).text,
    ).toBe("claude:b2 · (untitled)\n\nUSER: hi");
    expect(
      (
        await b.call("writer_delegate", {
          conversation_id: "a1",
          target_id: "b2",
          message: "check",
        })
      ).text,
    ).toContain("Task t1 queued for b2");
    const refused = await b.call("writer_get_task", { conversation_id: "a1", task_id: "t1" });
    expect(refused).toEqual({
      text: "Only the conversation whose turn is running can use the Writer tools",
      error: true,
    });
    expect(b.asked.map((a) => [a.method, a.params.threadId, a.key])).toEqual([
      ["list", "a1", "k"],
      ["read", "a1", "k"],
      ["delegate", "a1", "k"],
      ["task", "a1", "k"],
    ]);
    expect(b.asked[1]?.params.target).toBe("b2");
    expect((await b.rpc("nothing")).error).toMatchObject({ code: -32601 });
  });
});
