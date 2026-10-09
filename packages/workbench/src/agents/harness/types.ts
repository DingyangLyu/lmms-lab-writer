import type { WorkbenchKey as MessageKey } from "../../i18n";
import type { EditorSelectionContext } from "../selection-context";

export const HARNESSES = [
  { id: "opencode", label: "OpenCode" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
] as const;
export type HarnessId = (typeof HARNESSES)[number]["id"];
export type Harness = { id: HarnessId; label: string };
export function isHarnessId(value: unknown): value is HarnessId {
  return HARNESSES.some((h) => h.id === value);
}
export function harnessLabel(id: string) {
  return HARNESSES.find((h) => h.id === id)?.label || id;
}
/** A past conversation as the history dialog lists it. */
export type HistoryEntry = {
  id: string;
  title: string;
  updatedAt?: number;
  /** Shown instead of the session ID, e.g. who started a shared conversation. */
  detail?: string;
  /** Sharing applies (web): whether it is shared, and whether this member may change that. */
  shared?: boolean;
  mine?: boolean;
};
export type HistoryPage = { entries: HistoryEntry[]; cursor?: string | null };
/** One backend's past conversations in the current project. */
export type HistoryAdapter = {
  list: (cursor?: string) => Promise<HistoryPage>;
  rename: (id: string, title: string) => Promise<void>;
  share?: (id: string, shared: boolean) => Promise<void>;
  /** False while the backend is still connecting (OpenCode's server). */
  ready?: boolean;
};
export type ConversationStatus = "connecting" | "idle" | "running" | "waiting" | "error";
/** Message keys; translate with t() where shown. */
export const STATUS_LABELS: Record<ConversationStatus, MessageKey> = {
  connecting: "status.connecting",
  idle: "status.ready",
  running: "status.running",
  waiting: "status.waitingForApprovalOrAReply",
  error: "status.needsAttention",
};
export type ConversationInfo = {
  sessionId: string | null;
  title: string;
  status: ConversationStatus;
  hasDraft: boolean;
  queued: number;
};
export type ConversationTab = ConversationInfo & { id: string; backend: HarnessId };
export type ConversationTarget = { backend: HarnessId; tabId?: string };
export type IncomingMessage = {
  id: string;
  text: string;
  state: "pending" | "sending" | "paused" | "failed";
};
export type HarnessLifecycle = {
  instanceId?: string;
  openSessionIds?: string[];
  initialSessionId?: string | null;
  onConversationChange?: (info: ConversationInfo) => void;
  onNewConversation?: () => void;
  onShowHistory?: () => void;
  renamedConversation?: { id: string; title: string };
  onOpenConversation?: (id: string, title?: string) => void;
  incoming?: IncomingMessage;
  onIncomingAccepted?: (id: string) => void;
  onIncomingState?: (id: string, state: IncomingMessage["state"]) => void;
};
export type HarnessPanelProps = HarnessLifecycle & {
  active: boolean;
  directory?: string;
  onWorkingChange: (busy: boolean) => void;
  editorSelection: EditorSelectionContext | null;
  onClearSelection: () => void;
  onSelectionSent: (selection: EditorSelectionContext) => void;
  onBeforeSend: (selection: EditorSelectionContext | null) => Promise<void>;
  onFileClick: (path: string) => void;
};
