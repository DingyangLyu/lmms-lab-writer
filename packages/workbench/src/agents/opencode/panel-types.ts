import type { ChatImageFile } from "../chat/images";
import type { HarnessLifecycle } from "../harness/types";
import type { EditorSelectionContext } from "../selection-context";
import type { OpenCodeTransport } from "./client";

export type OpenCodeDaemonStatus = "stopped" | "starting" | "running" | "unavailable";

export type Props = HarnessLifecycle & {
  /** How the client reaches OpenCode; a local `opencode serve` at `baseUrl` when absent. */
  transport?: OpenCodeTransport;
  /** Shared runner: make the member's own conversation visible to the project, or private. */
  onShare?: (sessionId: string, shared: boolean) => Promise<unknown>;
  active?: boolean;
  onWorkingChange?: (busy: boolean) => void;
  className?: string;
  baseUrl?: string;
  directory?: string;
  autoConnect?: boolean;
  daemonStatus?: OpenCodeDaemonStatus;
  onRestartOpenCode?: () => void;
  onMaxReconnectFailed?: () => void;
  onFileClick?: (path: string) => void;
  pendingMessage?: string | null;
  onPendingMessageSent?: () => void;
  editorSelection?: EditorSelectionContext | null;
  onClearSelection?: () => void;
  onSelectionSent?: (selection: EditorSelectionContext) => void;
  onBeforeSend?: (selection: EditorSelectionContext | null) => Promise<void>;
};

export type TaskItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "low" | "medium" | "high";
};

export type AskUserQuestionOption = {
  label: string;
  description?: string;
};

export type AskUserQuestion = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
};

export type AttachedFile = ChatImageFile;
