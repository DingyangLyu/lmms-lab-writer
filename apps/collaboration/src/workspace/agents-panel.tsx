/**
 * The right column: the desktop's AI conversation panels, with the agents running on the lab's
 * shared runner (the workbench's RelayAgentsPanel, which the desktop also shows for folders
 * linked to a server). Owners and editors only.
 */
import {
  type EditorSelectionContext,
  RelayAgentsPanel,
  type RelayTask,
  relayProjectPath,
} from "@lmms-lab/workbench/agents";
import { useEffect, useMemo } from "react";
import type { PublicUser, Role } from "../../shared/api";
import { i18n, useI18n } from "../i18n";
import { webAgentLink } from "./agent-link";
import type { AiConversations } from "./ai-target";

/** Work from the page for an AI conversation: a chosen one, else the one in front. */
export type AiTask = RelayTask;
/** A path the agent printed: relative to the project, or inside the runner's copy of it. */
export const projectPath = relayProjectPath;

export function AgentsPanel({
  project,
  user,
  memberRole,
  ...props
}: {
  project: string;
  user: PublicUser;
  memberRole: Role;
  visible: boolean;
  /** The editor's selection, offered to the next message as context (as on the desktop). */
  selection: EditorSelectionContext | null;
  /** The selection was sent, or its chip removed. */
  onSelectionDone: (sent: EditorSelectionContext | null) => void;
  /** Work from the page (comments to address, a build to fix) for the current conversation. */
  task: AiTask | null;
  onTaskTaken: (id: number) => void;
  /** The open conversations, for choosing where work from the page goes. */
  onConversations?: (conversations: AiConversations) => void;
  onOpenFile: (path: string, line: number) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const allowed = memberRole === "owner" || memberRole === "editor";
  const link = useMemo(
    () => (allowed ? webAgentLink(project, user.id, () => i18n.getLocale()) : null),
    [allowed, project, user.id],
  );
  useEffect(() => () => link?.close(), [link]);
  if (!link) return <p className="p-4 text-sm text-muted">{t("agents.ownersAndEditorsOnly")}</p>;
  return <RelayAgentsPanel link={link} project={project} {...props} />;
}
