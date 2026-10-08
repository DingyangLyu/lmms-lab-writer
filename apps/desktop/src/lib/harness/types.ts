import type { EditorSelectionContext } from "@/lib/editor/selection-context";
import type { MessageKey } from "@/lib/i18n";

export const HARNESSES = [
  { id: "opencode", label: "OpenCode" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
] as const;
export type HarnessId = (typeof HARNESSES)[number]["id"];
export function isHarnessId(value: unknown): value is HarnessId {
  return HARNESSES.some((h) => h.id === value);
}
export function harnessLabel(id: string) {
  return HARNESSES.find((h) => h.id === id)?.label || id;
}
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
