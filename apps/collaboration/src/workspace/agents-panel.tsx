/**
 * The right column: the desktop's AI conversation panel, with Codex running on the lab's
 * shared runner. Conversations are private to whoever starts them unless shared; their edits
 * land in the shared text (a version is saved before every turn).
 */

import { workbenchI18n } from "@lmms-lab/workbench";
import {
  CodexPanel,
  type Harness,
  HarnessWorkspace,
  type HistoryAdapter,
  parseChatLink,
  useHarnessWorkspace,
} from "@lmms-lab/workbench/agents";
import { useEffect, useMemo } from "react";
import type { PublicUser, Role } from "../../shared/api";
import { i18n, useI18n } from "../i18n";
import { AgentLink, relayCodexBackend } from "./agent-link";

const HARNESSES: readonly Harness[] = [{ id: "codex", label: "Codex" }];
const PANELS = { codex: CodexPanel };

/** A path the agent printed: relative to the project, or inside the runner's copy of it. */
export function projectPath(reference: string, project: string) {
  const target = parseChatLink(reference.replace(/\\/g, "/"));
  if (target.kind !== "file" && target.kind !== "external-file") return null;
  const marker = `/${project}/`;
  const at = target.path.indexOf(marker);
  const path = at >= 0 ? target.path.slice(at + marker.length) : target.path;
  return path.startsWith("/") || /^[A-Za-z]:/.test(path) ? null : { path, line: target.line };
}

export function AgentsPanel({
  project,
  user,
  memberRole,
  visible,
  onOpenFile,
  onError,
}: {
  project: string;
  user: PublicUser;
  memberRole: Role;
  visible: boolean;
  onOpenFile: (path: string, line: number) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const allowed = memberRole === "owner" || memberRole === "editor";
  const link = useMemo(
    () => (allowed ? new AgentLink(project, user.id, () => i18n.getLocale()) : null),
    [allowed, project, user.id],
  );
  useEffect(() => () => link?.close(), [link]);
  const backend = useMemo(() => link && relayCodexBackend(link), [link]);
  const workspace = useHarnessWorkspace(allowed ? project : null);
  // One backend: an empty column opens a conversation instead of asking which.
  useEffect(() => {
    if (allowed && workspace.ready && !workspace.tabs.length) workspace.open("codex");
  }, [allowed, workspace]);
  if (!allowed || !backend)
    return <p className="p-4 text-sm text-muted">{t("agents.ownersAndEditorsOnly")}</p>;
  const history: HistoryAdapter = {
    list: async () => {
      const { data = [] } = await backend.listThreads(project);
      return {
        entries: data.map((thread) => ({
          id: thread.id,
          title: thread.name || workbenchI18n.t("codex.untitledConversation"),
          updatedAt: thread.updated,
          detail: thread.mine
            ? workbenchI18n.t(thread.shared ? "harness.shared" : "harness.private")
            : workbenchI18n.t("codex.sharedByName", { name: thread.ownerName ?? "" }),
          shared: thread.shared,
          mine: thread.mine,
        })),
      };
    },
    rename: async (id, title) => {
      await backend.renameThread(id, title);
    },
    share: async (id, shared) => {
      await backend.shareThread?.(id, shared);
    },
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <HarnessWorkspace
        workspace={workspace}
        visible={visible}
        preferredBackend="codex"
        harnesses={HARNESSES}
        panels={PANELS}
        panelProps={{ codex: { backend } }}
        history={() => history}
        onBackendChange={() => {}}
        shared={{
          directory: project,
          onFileClick: (reference) => {
            const target = projectPath(reference, project);
            if (target) onOpenFile(target.path, target.line ?? 1);
            else onError(t("agents.notInProject", { path: reference }));
          },
          editorSelection: null,
          onClearSelection: () => {},
          onSelectionSent: () => {},
          onBeforeSend: async () => {},
        }}
      />
    </div>
  );
}
