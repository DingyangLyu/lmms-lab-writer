/** Codex on this computer: the app-server the Rust side runs with the user's own sign-in. */
import type { CodexBackend, CodexEvent } from "@lmms-lab/workbench/agents";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const desktopCodexBackend: CodexBackend = {
  kind: "local",
  initialize: async () => {
    await invoke("codex_initialize");
  },
  listModels: () => invoke("codex_list_models"),
  listThreads: (directory) => invoke("codex_list_threads", { cwd: directory }),
  resumeThread: (threadId, permissionMode) =>
    invoke("codex_resume_thread", { threadId, permissionMode }),
  readThread: (threadId) => invoke("codex_read_thread", { threadId }),
  startThread: (directory, model, permissionMode) =>
    invoke("codex_start_thread", { cwd: directory, model, permissionMode }),
  startTurn: ({ threadId, text, images, model, effort, permissionMode }) =>
    invoke("codex_start_turn", { threadId, text, images, model, effort, permissionMode }),
  steerTurn: ({ threadId, expectedTurnId, text, images }) =>
    invoke("codex_steer_turn", { threadId, expectedTurnId, text, images }),
  interruptTurn: (threadId, turnId) => invoke("codex_interrupt_turn", { threadId, turnId }),
  renameThread: (threadId, name) => invoke("codex_rename_thread", { threadId, name }),
  respond: (_threadId, requestId, response) =>
    invoke("codex_respond_to_request", { requestId, response }),
  pendingRequests: () => invoke("codex_pending_requests"),
  // Rust emits Codex events to the whole app, as before the panel moved.
  listen: (handler) => listen<CodexEvent>("codex://event", ({ payload }) => handler(payload)),
};
