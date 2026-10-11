/**
 * The shared runner: hosts the web's live AI conversations (agent-host.ts) on a machine with
 * the agent CLIs signed in, over one socket to the server with the shared runner token
 * (WRITER_SHARED_RUNNER_TOKEN on the server). The server never receives the CLIs' credentials
 * or a shell.
 */
import "./environment";
import { resolve } from "node:path";
import { startAgentHost } from "./agent-host";

const origin = (process.env.WRITER_SERVER || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.WRITER_RUNNER_TOKEN || "";
const AGENTS = ["codex", "claude", "opencode"];
const allowed = (process.env.WRITER_ALLOWED_HARNESSES || "codex")
  .split(",")
  .map((h) => h.trim())
  .filter((h) => AGENTS.includes(h));

export function runWorker() {
  if (!token) throw new Error("请把 WRITER_RUNNER_TOKEN 设为服务器的 WRITER_SHARED_RUNNER_TOKEN");
  if (!allowed.length || process.env.WRITER_AGENT_HOST === "0")
    throw new Error("WRITER_ALLOWED_HARNESSES 里没有可托管的 AI（codex、claude、opencode）");
  console.log(`Writer runner connected to ${origin}; capabilities: ${allowed.join(",")}`);
  const host = startAgentHost({ server: origin, token, harnesses: allowed });
  // The agents' processes go with the runner when it is asked to stop.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      host.stop();
      process.exit(0);
    });
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  try {
    runWorker();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
