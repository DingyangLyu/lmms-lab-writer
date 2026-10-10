import type { RefObject } from "react";
import type { FileInfo, ProjectSummary, PublicUser, Role } from "../../shared/api";
import type { EditorHandle } from "../editor";
import type { SyncStatus } from "../provider";
import type { AiChoice, AiConversations } from "./ai-target";
import type { SentNotes } from "./notes";

/** What every workspace panel needs from the page around it. */
export type WorkspaceContext = {
  prefix: string;
  project: ProjectSummary;
  user: PublicUser;
  role: Role;
  canEdit: boolean;
  canComment: boolean;
  busy: boolean;
  /** Runs a request, tracking busy state and showing its error in the banner. */
  run: (action: () => Promise<void>) => void;
  reload: () => Promise<void>;
  notify: (message: string) => void;
  report: (message: string) => void;
  editor: RefObject<EditorHandle | null>;
  file: FileInfo | null;
  files: FileInfo[];
  openFile: (file: FileInfo) => void;
  status: SyncStatus;
  /**
   * Hands work (comments to address, a build to fix) to the AI conversation chosen in `ai`;
   * editors only. Comments named in `notes` are remembered as sent there.
   */
  askAi: ((text: string, notes?: string[]) => void) | null;
  /** Where work goes: the choice, the AI panel's conversations, and what was sent where. */
  ai: {
    choice: AiChoice;
    setChoice: (choice: AiChoice) => void;
    conversations: AiConversations;
    sent: SentNotes;
  };
};
