/**
 * Where the Claude Code panel's conversations run: the desktop's own CLI bridge (this
 * computer's sign-in), or the web server's relay to the lab's shared runner. Both speak
 * Claude Code's stream-json events, so the panel and its transcript are the same either way.
 */
import type { ClaudeEvent } from "./events";

export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";
export type ClaudeModel = { value: string; displayName: string; supportedEffortLevels?: string[] };
export type ClaudeSession = {
  id: string;
  name: string;
  directory: string;
  updatedAt: number;
  /** Shared runner only: who started it and whether the project can see it. */
  mine?: boolean;
  shared?: boolean;
  ownerName?: string;
};
export type ClaudeSnapshot = {
  session: ClaudeSession;
  events: ClaudeEvent[];
  busy: boolean;
  pending: ClaudeEvent[];
};
/** One stream-json event of a session, plus Writer's own `writer_*` turn markers. */
export type ClaudeEnvelope = { directory?: string; sessionId: string; event: ClaudeEvent };
/** Events a shared backend adds (see apps/collaboration/shared/agents.ts). */
export const CLAUDE_SESSIONS_EVENT = "writer_sessions";

export type ClaudeBackend = {
  /** "local": Claude Code signed in on this computer; "shared": the lab runner, via the server. */
  kind: "local" | "shared";
  initialize: (directory: string) => Promise<{ models?: ClaudeModel[] }>;
  listSessions: (directory: string) => Promise<ClaudeSession[]>;
  createSession: (directory: string) => Promise<ClaudeSession>;
  readSession: (directory: string, sessionId: string) => Promise<ClaudeSnapshot>;
  renameSession: (directory: string, sessionId: string, name: string) => Promise<unknown>;
  startTurn: (turn: {
    directory: string;
    sessionId: string;
    text: string;
    images: string[];
    options: { model: string; effort: string | null; permissionMode: ClaudePermissionMode };
  }) => Promise<unknown>;
  steerTurn: (turn: {
    directory: string;
    sessionId: string;
    text: string;
    images: string[];
  }) => Promise<unknown>;
  respondPermission: (
    sessionId: string,
    requestId: string,
    allow: boolean,
    answers: Record<string, string> | null,
  ) => Promise<unknown>;
  stop: (sessionId: string) => Promise<unknown>;
  listen: (handler: (payload: ClaudeEnvelope) => void) => Promise<() => void>;
  /** The permission modes it can honour, once initialized; all of them when absent. */
  permissions?: () => ClaudePermissionMode[];
  shareSession?: (sessionId: string, shared: boolean) => Promise<unknown>;
};
