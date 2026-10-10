import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-")));
const account = join(root, ".claude-lab");
const folder = join(root, "paper");
mkdirSync(join(account, "projects", "-paper"), { recursive: true });
mkdirSync(join(account, "sessions"), { recursive: true });
mkdirSync(folder);
const id = "11111111-2222-3333-4444-555555555555";
const row = (fields) => JSON.stringify({ sessionId: id, cwd: folder, ...fields });
writeFileSync(
  join(account, "projects", "-paper", `${id}.jsonl`),
  [
    row({
      type: "user",
      timestamp: "2026-10-10T01:00:00Z",
      origin: { kind: "human" },
      message: { role: "user", content: "Fix the abstract of the paper" },
    }),
    row({
      type: "assistant",
      timestamp: "2026-10-10T01:00:05Z",
      message: {
        content: [
          { type: "text", text: "Reading main.tex" },
          { type: "tool_use", name: "Edit", input: { file_path: `${folder}/main.tex` } },
          { type: "tool_use", name: "Bash", input: { command: "git commit -m 'abstract'" } },
        ],
      },
    }),
    row({
      type: "user",
      timestamp: "2026-10-10T01:00:06Z",
      toolUseResult: {},
      message: { content: [{ type: "tool_result", content: "ok" }] },
    }),
    row({
      type: "assistant",
      isSidechain: true,
      timestamp: "2026-10-10T01:00:07Z",
      message: { content: [{ type: "text", text: "subagent chatter" }] },
    }),
    row({
      type: "assistant",
      timestamp: "2026-10-10T01:00:09Z",
      message: { content: [{ type: "text", text: "The abstract now names MatOS." }] },
    }),
    JSON.stringify({ type: "ai-title", aiTitle: "Abstract fixes", sessionId: id }),
  ].join("\n"),
);
// Registered as running under this test's process, which is alive.
writeFileSync(
  join(account, "sessions", `${process.pid}.json`),
  JSON.stringify({ pid: process.pid, sessionId: id, cwd: folder, status: "idle", name: "lab-7" }),
);
// A stand-in for the Claude CLI: answers with its arguments and folder.
const fake = join(root, "claude");
writeFileSync(
  fake,
  `#!/bin/sh\nargs=$(printf '%s ' "$@" | tr '\\n"' "  ")\nprintf '{"type":"result","is_error":false,"result":"did it in %s with %s","session_id":"forked-1","total_cost_usd":0.01,"num_turns":2}\\n' "$PWD" "$args"\n`,
);
chmodSync(fake, 0o755);
process.env.AGENT_HUB_DIRS = account;
process.env.AGENT_HUB_HOME = join(root, "hub");
process.env.AGENT_HUB_CLAUDE = fake;
const hub = await import("./agent-hub.mjs");

test("lists sessions of every account with what they are doing", () => {
  const [s] = hub.sessions();
  assert.equal(s.id, id);
  assert.equal(s.account, "lab");
  assert.equal(s.status, "idle");
  assert.equal(s.name, "lab-7");
  assert.equal(s.title, "Abstract fixes");
  assert.equal(s.lastReply, "The abstract now names MatOS.");
  assert.equal(hub.findSession("lab-7").id, id);
  assert.equal(hub.findSession("111111").id, id);
  assert.throws(() => hub.findSession("nope"), /No session/);
});

test("reads requests, edits, commits and replies, without subagents' steps", async () => {
  const s = hub.findSession(id);
  const summary = await hub.describe(s);
  assert.match(summary, /Fix the abstract of the paper/);
  assert.match(summary, /main\.tex/);
  assert.match(summary, /git commit -m 'abstract'/);
  assert.match(summary, /The abstract now names MatOS/);
  assert.doesNotMatch(summary, /subagent chatter/);
  assert.match(await hub.describe(s, { mode: "tools" }), /Edit: .*main\.tex/);
  assert.match(await hub.describe(s, { mode: "search", query: "names" }), /MatOS/);
});

test("delegates to a fork of a session and keeps the result", async () => {
  const task = hub.delegate({ session: "lab-7", task: "Check the citations" });
  let report;
  for (let i = 0; i < 50; i++) {
    report = hub.taskReport(task);
    if (report.state === "done" || report.state === "failed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(report.state, "done", report.text);
  assert.match(report.text, new RegExp(`did it in ${folder.replace(/[/.]/g, "\\$&")}`));
  assert.match(report.text, new RegExp(`--resume ${id} --fork-session`));
  assert.match(report.text, /Session of the run: forked-1/);
  const spec = JSON.parse(readFileSync(join(root, "hub", "tasks", task, "task.json"), "utf8"));
  assert.equal(spec.accountDir, account);
  assert.match(spec.prompt, /Check the citations/);
});

test("a delegated run cannot delegate again", () => {
  process.env.AGENT_HUB_DEPTH = "1";
  try {
    assert.throws(() => hub.delegate({ session: id, task: "loop" }), /cannot delegate further/);
  } finally {
    delete process.env.AGENT_HUB_DEPTH;
  }
});

test("speaks MCP over stdio", async () => {
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("./agent-hub.mjs", import.meta.url))],
    {
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const replies = createInterface({ input: server.stdout });
  const waiting = new Map();
  replies.on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let next = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const n = ++next;
      waiting.set(n, resolve);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.equal(init.result.serverInfo.name, "agent-hub");
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const { result } = await call("tools/list", {});
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["hub_sessions", "hub_read", "hub_delegate", "hub_task"],
  );
  const listed = await call("tools/call", { name: "hub_sessions", arguments: {} });
  assert.match(listed.result.content[0].text, /lab-7 · idle/);
  const missing = await call("tools/call", {
    name: "hub_read",
    arguments: { session: "zzzzzzzz" },
  });
  assert.equal(missing.result.isError, true);
  server.kill();
});
