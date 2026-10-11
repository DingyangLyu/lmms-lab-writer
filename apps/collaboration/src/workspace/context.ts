import type { RefObject } from "react";
import type { FileInfo, Member, ProjectSummary, PublicUser, Role } from "../../shared/api";
import type { EditorHandle } from "../editor";
import type { SyncStatus } from "../provider";
import type { AiChoice, AiConversations } from "./ai-target";
import type { CommentOps } from "./comment-ops";

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
   * editors only. Comments named in `notes` are recorded as handed there, for everyone to see.
   */
  askAi: ((text: string, notes?: string[]) => void) | null;
  /** Where work goes: the choice and the AI panel's conversations. */
  ai: {
    choice: AiChoice;
    setChoice: (choice: AiChoice) => void;
    conversations: AiConversations;
  };
  /** The project's members, whom comments can name with @. */
  members: Member[];
  /** Changes to comment threads, shown at once. */
  comments: CommentOps;
};
