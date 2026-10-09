#!/usr/bin/env node
// Test stand-in for `codex app-server --listen stdio://` (agents.test.ts). A turn's text,
// after Writer's context line, is a command: `replace <path> <from>=><to>`, `create <path>
// <text>`, `delete <path>`, `ask <path> <from>=><to>` (asks for approval first) or anything
// else to just answer. Every turn ends with an agent message and turn/completed.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const threads = new Map();
const waiting = new Map();
let nextRequest = 1;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => write({ method, params });

function edit(thread, turnId, command) {
  const [verb, path, ...rest] = command.split(" ");
  const file = join(thread.cwd, path ?? "");
  if (verb === "replace" || verb === "ask") {
    const [from, to] = rest.join(" ").split("=>");
    writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
  } else if (verb === "create") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rest.join(" "));
  } else if (verb === "delete") rmSync(file);
  else return false;
  notify("item/completed", {
    threadId: thread.id,
    turnId,
    item: { type: "fileChange", id: randomUUID(), status: "completed", changes: [{ path }] },
  });
  return true;
}
function finish(thread, turn, text) {
  notify("item/completed", {
    threadId: thread.id,
    turnId: turn.id,
    item: { type: "agentMessage", id: randomUUID(), text },
  });
  turn.status = "completed";
  turn.items.push({ type: "agentMessage", id: randomUUID(), text });
  notify("turn/completed", { threadId: thread.id, turn: { id: turn.id, status: "completed" } });
}
function startTurn(thread, input) {
  const text = input.find((part) => part.type === "text")?.text ?? "";
  const command = text.split("\n\n").slice(1).join("\n\n").trim();
  const turn = { id: randomUUID(), status: "inProgress", items: [], text };
  turn.items.push({ type: "userMessage", id: randomUUID(), content: input });
  thread.turns.push(turn);
  setTimeout(() => {
    notify("turn/started", { threadId: thread.id, turn: { id: turn.id, status: "inProgress" } });
    if (command.startsWith("ask ")) {
      const id = nextRequest++;
      waiting.set(id, (result) => {
        notify("serverRequest/resolved", { threadId: thread.id, requestId: id });
        if (result.decision === "accept") edit(thread, turn.id, command);
        finish(thread, turn, result.decision === "accept" ? "changed" : "declined");
      });
      write({
        id,
        method: "item/fileChange/requestApproval",
        params: { threadId: thread.id, turnId: turn.id, itemId: "edit", reason: "Edit the paper" },
      });
      return;
    }
    edit(thread, turn.id, command);
    finish(thread, turn, `done: ${command || "nothing"}`);
  }, 20);
  return turn;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result ?? {});
    waiting.delete(message.id);
    return;
  }
  const { id, method, params = {} } = message;
  const reply = (result) => write({ id, result });
  const thread = threads.get(params.threadId);
  switch (method) {
    case "initialize":
      return reply({ userAgent: "fake-codex" });
    case "initialized":
      return;
    case "model/list":
      return reply({
        data: [
          {
            id: "fake-model",
            model: "fake-model",
            displayName: "Fake model",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
          },
        ],
      });
    case "thread/start": {
      const created = { id: randomUUID(), cwd: params.cwd, model: params.model, turns: [] };
      threads.set(created.id, created);
      return reply({ thread: { id: created.id, cwd: created.cwd }, model: params.model });
    }
    case "thread/resume":
    case "thread/name/set":
      return thread
        ? reply({ thread: { id: thread.id } })
        : write({ id, error: { message: "no such thread" } });
    case "thread/read":
      return reply({
        thread: {
          id: thread?.id,
          status: { type: "idle" },
          turns: (thread?.turns ?? []).map((t) => ({ id: t.id, status: t.status, items: t.items })),
        },
      });
    case "turn/start":
      return reply({ turn: { id: startTurn(thread, params.input).id, status: "inProgress" } });
    case "turn/steer":
      return reply({ turnId: params.expectedTurnId });
    case "turn/interrupt":
      return reply({});
    default:
      return write({ id, error: { message: `unsupported ${method}` } });
  }
});
