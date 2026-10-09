/** Claude Code on this computer: the Rust bridge runs the CLI with the user's own sign-in. */
import type { ClaudeBackend, ClaudeEnvelope } from "@lmms-lab/workbench/agents";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const desktopClaudeBackend: ClaudeBackend = {
  kind: "local",
  initialize: (directory) => invoke("claude_initialize", { cwd: directory }),
  listSessions: (directory) => invoke("claude_list_sessions", { cwd: directory }),
  createSession: (directory) => invoke("claude_create_session", { cwd: directory }),
  readSession: (directory, sessionId) =>
    invoke("claude_read_session", { cwd: directory, sessionId }),
  renameSession: (directory, sessionId, name) =>
    invoke("claude_rename_session", { cwd: directory, sessionId, name }),
  startTurn: ({ directory, sessionId, text, images, options }) =>
    invoke("claude_start_turn", { cwd: directory, sessionId, text, images, options }),
  steerTurn: ({ directory, sessionId, text, images }) =>
    invoke("claude_steer_turn", { cwd: directory, sessionId, text, images }),
  respondPermission: (sessionId, requestId, allow, answers) =>
    invoke("claude_respond_permission", { sessionId, requestId, allow, answers }),
  stop: (sessionId) => invoke("claude_stop", { sessionId }),
  // Rust emits Claude events to the whole app, as before the panel moved.
  listen: (handler) => listen<ClaudeEnvelope>("claude://event", ({ payload }) => handler(payload)),
};
