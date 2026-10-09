/**
 * Where the Codex panel's conversations run: the desktop app's own Codex app-server (this
 * computer's sign-in), or the web server's relay to the lab's shared runner. Both speak the
 * app-server protocol, so the panel and its transcript are the same either way.
 */
import type { CodexEvent, CodexItem } from "./events";

export type CodexPermissionMode = "readOnly" | "askForApproval" | "autoReview" | "fullAccess";
export type CodexModel = {
  id: string;
  model?: string;
  displayName?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
};
export type CodexThreadSummary = {
  id: string;
  name?: string | null;
  preview?: string | null;
  /** Shared runner only: who started it and whether the project can see it. */
  mine?: boolean;
  shared?: boolean;
  ownerName?: string;
  updated?: number;
};
export type CodexThreadRecord = {
  status?: { type?: string };
  turns?: Array<{ id?: string; status?: string; items?: CodexItem[] }>;
};
/** Events a shared backend adds to Codex's own (see apps/collaboration/shared/agents.ts). */
export const CODEX_THREADS_EVENT = "writer/threads";
export const CODEX_CHANGES_EVENT = "writer/changes";
export const CODEX_BUSY_EVENT = "writer/busy";
export type CodexChangeResult = {
  path: string;
  status: "applied" | "proposal" | "skipped";
  reason?: string;
};

export type CodexBackend = {
  /** "local": Codex signed in on this computer; "shared": the lab runner, via the server. */
  kind: "local" | "shared";
  initialize: () => Promise<void>;
  listModels: () => Promise<{ data?: CodexModel[] }>;
  listThreads: (directory: string) => Promise<{ data?: CodexThreadSummary[] }>;
  resumeThread: (threadId: string, permissionMode: CodexPermissionMode) => Promise<unknown>;
  readThread: (threadId: string) => Promise<{ thread?: CodexThreadRecord }>;
  startThread: (
    directory: string,
    model: string | null,
    permissionMode: CodexPermissionMode,
  ) => Promise<{ thread: { id: string } }>;
  startTurn: (turn: {
    threadId: string;
    text: string;
    images: string[];
    model: string | null;
    effort: string | null;
    permissionMode: CodexPermissionMode;
  }) => Promise<{ turn: { id: string } }>;
  steerTurn: (turn: {
    threadId: string;
    expectedTurnId: string;
    text: string;
    images: string[];
  }) => Promise<unknown>;
  interruptTurn: (threadId: string, turnId: string) => Promise<unknown>;
  renameThread: (threadId: string, name: string) => Promise<unknown>;
  respond: (
    threadId: string | null,
    requestId: number | string,
    response: Record<string, unknown>,
  ) => Promise<unknown>;
  pendingRequests: () => Promise<CodexEvent[]>;
  /** Codex notifications and approval requests, plus `codex/connectionClosed`. */
  listen: (handler: (event: CodexEvent) => void) => Promise<() => void>;
  /** The permission modes it can honour, once initialized; all of them when absent. */
  permissions?: () => CodexPermissionMode[];
  shareThread?: (threadId: string, shared: boolean) => Promise<unknown>;
};
