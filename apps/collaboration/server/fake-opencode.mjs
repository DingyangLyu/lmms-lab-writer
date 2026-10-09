#!/usr/bin/env node
// Test stand-in for `opencode serve --hostname 127.0.0.1 --port N` (agents.test.ts): sessions
// per project folder, server-sent events, and prompts that are commands (`replace <path>
// <from>=><to>`) run as one tool step. `/config` and `/provider` carry a key that must not
// reach the browser.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const sessions = new Map();
const streams = new Set();
let next = 0;
const json = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const emit = (directory, event) => {
  for (const stream of streams)
    if (stream.directory === directory) stream.res.write(`data: ${JSON.stringify(event)}\n\n`);
};
const body = (req) =>
  new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => resolve(text ? JSON.parse(text) : {}));
  });
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const directory = url.searchParams.get("directory") ?? "";
  const path = url.pathname;
  if (path === "/config")
    return json(res, {
      model: "fake/model",
      provider: { fake: { options: { apiKey: "sk-secret" } } },
    });
  if (path === "/agent") return json(res, [{ name: "build", mode: "primary", prompt: "x" }]);
  if (path === "/provider")
    return json(res, {
      all: [
        {
          id: "fake",
          name: "Fake",
          options: { apiKey: "sk-secret" },
          models: {
            model: {
              id: "model",
              name: "Model",
              variants: { high: { disabled: false, apiKey: "sk-secret" } },
            },
          },
        },
      ],
      connected: ["fake"],
    });
  if (path === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    const stream = { directory, res };
    streams.add(stream);
    req.on("close", () => streams.delete(stream));
    return;
  }
  if (path === "/session" && req.method === "POST") {
    const session = {
      id: `ses_${++next}`,
      title: "New session",
      directory,
      time: { created: Date.now(), updated: Date.now() },
      messages: [],
    };
    sessions.set(session.id, session);
    return json(res, session);
  }
  if (path === "/session")
    return json(
      res,
      [...sessions.values()]
        .filter((s) => s.directory === directory)
        .map(({ messages, ...s }) => s),
    );
  if (path === "/session/status")
    return json(res, Object.fromEntries([...sessions.keys()].map((id) => [id, { type: "idle" }])));
  const match = /^\/session\/([^/]+)(\/.*)?$/.exec(path);
  const session = match && sessions.get(match[1]);
  if (!session) return json(res, { error: "not found" }, 404);
  const rest = match[2] ?? "";
  if (rest === "" && req.method === "PATCH") {
    session.title = (await body(req)).title;
    return json(res, session);
  }
  if (rest === "") return json(res, session);
  if (rest === "/message") return json(res, session.messages);
  if (rest === "/abort") return json(res, true);
  if (rest === "/prompt_async") {
    const prompt = await body(req);
    const text = prompt.parts?.find((p) => p.type === "text")?.text ?? "";
    session.lastPrompt = text;
    const command = text.split("\n\n").slice(1).join("\n\n").trim();
    res.writeHead(204);
    res.end();
    setTimeout(() => {
      emit(directory, {
        type: "session.status",
        properties: { sessionID: session.id, status: { type: "busy" } },
      });
      if (command.startsWith("replace ")) {
        const [, file, ...rest2] = command.split(" ");
        const [from, to] = rest2.join(" ").split("=>");
        const full = join(directory, file);
        writeFileSync(full, readFileSync(full, "utf8").replace(from, to));
        emit(directory, {
          type: "message.part.updated",
          properties: {
            part: {
              id: "p1",
              sessionID: session.id,
              messageID: "m1",
              type: "tool",
              tool: "edit",
              state: { status: "completed" },
            },
          },
        });
      }
      session.messages.push({
        info: { id: "m1", sessionID: session.id, role: "assistant" },
        parts: [{ type: "text", text: "done" }],
      });
      emit(directory, {
        type: "session.status",
        properties: { sessionID: session.id, status: { type: "idle" } },
      });
      emit(directory, { type: "session.idle", properties: { sessionID: session.id } });
    }, 50);
    return;
  }
  json(res, { error: "unsupported" }, 404);
}).listen(port, "127.0.0.1");
