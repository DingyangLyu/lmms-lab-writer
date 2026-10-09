#!/usr/bin/env node
// Test stand-in for `claude -p --input-format stream-json --output-format stream-json`
// (agents.test.ts). A user message is a command: `replace <path> <from>=><to>`; in the
// `default` permission mode the edit is asked for first. The result says whether the session
// was resumed.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const mode = args[args.indexOf("--permission-mode") + 1];
const resumed = args.some((a) => a.startsWith("--resume="));
const session = (args.find((a) => /^--(resume|session-id)=/.test(a)) ?? "").split("=")[1];
const write = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let waiting = null;

function finish(text) {
  write({ type: "assistant", message: { id: "m2", content: [{ type: "text", text }] } });
  write({ type: "result", subtype: "success", is_error: false, result: text });
}
function edit(command) {
  const [, path, ...rest] = command.split(" ");
  const [from, to] = rest.join(" ").split("=>");
  const file = join(process.cwd(), path);
  writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
  write({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "edited" }] },
  });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request?.subtype === "initialize")
    return write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          models: [{ value: "default", displayName: "Default", supportedEffortLevels: ["high"] }],
        },
      },
    });
  if (message.type === "control_response") {
    const allow = message.response?.response?.behavior === "allow";
    if (allow) waiting?.();
    return finish(allow ? `changed${resumed ? " (resumed)" : ""}` : "declined");
  }
  if (message.type !== "user") return;
  const command = message.message.content.find((part) => part.type === "text")?.text ?? "";
  write({ type: "system", subtype: "init", session_id: session });
  if (!command.startsWith("replace ")) return finish(`said: ${command}`);
  write({
    type: "assistant",
    message: {
      id: "m1",
      content: [
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: command.split(" ")[1] } },
      ],
    },
  });
  if (mode === "default") {
    waiting = () => edit(command);
    return write({
      type: "control_request",
      request_id: "p1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Edit",
        input: { file_path: command.split(" ")[1] },
      },
    });
  }
  edit(command);
  finish(`changed${resumed ? " (resumed)" : ""}`);
});
