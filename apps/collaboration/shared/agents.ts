/**
 * Live AI conversations in the browser. The agents run on the server's shared runner (the lab
 * workstation); the server relays between browsers and that runner, decides who may see and
 * use each conversation, and merges the files an agent changes into the shared text.
 *
 * Both links carry JSON messages: a request `{id, method, params}` is answered by
 * `{id, result}` or `{id, error}`; `{event}` is an agent notification or approval request
 * (Codex app-server JSON-RPC), and `{status}` / `{busy}` update the browser.
 *
 * Browser → server: `codex.initialize`, `codex.models`, `codex.threads`, `codex.startThread`,
 * `codex.resume`, `codex.read`, `codex.startTurn`, `codex.steer`, `codex.interrupt`,
 * `codex.rename`, `codex.respond`, `codex.pending`; `claude.initialize`, `claude.sessions`,
 * `claude.createSession`, `claude.read`, `claude.rename`, `claude.startTurn`, `claude.steer`,
 * `claude.respond`, `claude.stop`; and `thread.share` for any of them.
 * Server → runner: the same methods with the project and its files added.
 * Runner → server: `files.read` (binary contents) and `changes` (what the agent edited).
 * Claude Code's stream-json events travel as `{method: "claude/event", params: {threadId,
 * event}}`; `writer_started` / `writer_done` mark a turn. OpenCode's client keeps its HTTP API:
 * `opencode.fetch {method, path, body}` covers the calls the panel makes (the server checks
 * each session's access; the runner allows only those calls and strips configuration), and its
 * events travel as `{method: "opencode/event", params: {threadId, event}}`.
 */

/** The permission choices of each composer (as on the desktop). */
export type AgentPermission = "readOnly" | "askForApproval" | "autoReview" | "fullAccess";
export const AGENT_PERMISSIONS: readonly AgentPermission[] = [
  "readOnly",
  "askForApproval",
  "autoReview",
  "fullAccess",
];
export const CLAUDE_PERMISSIONS = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;
export type ClaudePermission = (typeof CLAUDE_PERMISSIONS)[number];
/** OpenCode has no permission choice in its composer; the runner's configuration decides. */
export const HARNESS_PERMISSIONS: Record<string, readonly string[]> = {
  codex: AGENT_PERMISSIONS,
  claude: CLAUDE_PERMISSIONS,
  opencode: [],
};
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

/** A project file as the runner's working copy receives it before a turn. */
export type AgentFile = {
  path: string;
  binary: boolean;
  revision: number;
  /** Text files only; binary contents are fetched when the runner's copy is outdated. */
  content?: string;
};

/** A file the agent created, changed or deleted, with the version it started from. */
export type AgentChange = {
  path: string;
  /** Text at the turn's start (or the last push); null for a new file. */
  base: string | null;
  /** The binary revision the change replaces. */
  revision?: number;
  content?: string;
  base64?: string;
  deleted?: boolean;
};

/**
 * What became of one change: merged into the shared text, kept as a suggestion because a
 * collaborator changed the same lines, or not applied (the file changed type, was replaced
 * by someone else, or broke a limit).
 */
export type AgentChangeResult = {
  path: string;
  status: "applied" | "proposal" | "skipped";
  revision?: number;
  reason?: string;
};

/** Sent to a conversation's browsers once the shared project has the agent's changes. */
export const CHANGES_EVENT = "writer/changes";
/** Sent to a project's browsers when its list of conversations changed. */
export const THREADS_EVENT = "writer/threads";

export type AgentEvent = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

export type AgentMessage =
  | { id: string; method: string; params?: Record<string, unknown> }
  | { id: string; result?: unknown; error?: string }
  | { event: AgentEvent; project?: string }
  | { status: AgentStatus }
  | { busy: AgentBusy };
