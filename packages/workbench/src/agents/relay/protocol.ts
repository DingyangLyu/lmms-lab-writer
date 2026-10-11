/**
 * The browser's half of the AI relay protocol (the server's in apps/collaboration/server/
 * agents.ts): what the server says about the runner, the project's conversations, and the
 * events that are Writer's own. Shared by the web app, the desktop app (for folders linked to
 * a server) and the server, so it imports nothing.
 */
export const CLAUDE_EVENT = "claude/event";
/** OpenCode's own server-sent events, for one session: `{threadId, event}`. */
export const OPENCODE_EVENT = "opencode/event";

export type AgentStatus = {
  online: boolean;
  /** The runner's name, e.g. the lab workstation. */
  name: string | null;
  harnesses: string[];
  /** Per harness, the permission modes this runner can honour (Codex's sandbox does not run everywhere). */
  permissions: Record<string, string[]>;
};

/** A conversation as the project lists it: private to its owner unless shared. */
export type AgentThread = {
  id: string;
  harness: string;
  name: string | null;
  owner: string;
  ownerName: string;
  /** Started by this member in this project: they may rename it or hide it. */
  mine: boolean;
  shared: boolean;
  updated: number;
  /** A conversation of another project shown here read-only, and that project. */
  linkedFrom: { id: string; name: string } | null;
};

/** Who is running an AI turn in the project; one turn at a time per project. */
export type AgentBusy = { thread: string; user: string; userName: string } | null;

/** Sent to a conversation's browsers once the shared project has the agent's changes. */
export const CHANGES_EVENT = "writer/changes";
/** Sent to a project's browsers when its list of conversations changed. */
export const THREADS_EVENT = "writer/threads";
