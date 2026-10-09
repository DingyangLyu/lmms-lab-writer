/**
 * The right column: the desktop's AI conversation panels, with the agents running on the lab's
 * shared runner. Conversations are private to whoever starts them unless shared; their edits
 * land in the shared text (a version is saved before every turn).
 */
import { workbenchI18n } from "@lmms-lab/workbench";
import {
  ClaudePanel,
  CodexPanel,
  HARNESSES,
  HarnessButtons,
  type HarnessId,
  HarnessWorkspace,
  type HistoryAdapter,
  type HistoryEntry,
  parseChatLink,
  useHarnessWorkspace,
} from "@lmms-lab/workbench/agents";
import { useEffect, useMemo, useState } from "react";
import type { PublicUser, Role } from "../../shared/api";
import { i18n, useI18n } from "../i18n";
import { AgentLink, relayClaudeBackend, relayCodexBackend } from "./agent-link";

const PANELS = { codex: CodexPanel, claude: ClaudePanel };
/** How a conversation shows in the history: whose it is and whether it is shared. */
const entry = (item: {
  id: string;
  name?: string | null;
  updated?: number;
  mine?: boolean;
  shared?: boolean;
  ownerName?: string;
}): HistoryEntry => ({
  id: item.id,
  title: item.name || workbenchI18n.t("codex.untitledConversation"),
  updatedAt: item.updated,
  detail: item.mine
    ? workbenchI18n.t(item.shared ? "harness.shared" : "harness.private")
    : workbenchI18n.t("codex.sharedByName", { name: item.ownerName ?? "" }),
  shared: item.shared,
  mine: item.mine,
});

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
  const backends = useMemo(
    () => link && { codex: relayCodexBackend(link), claude: relayClaudeBackend(link) },
    [link],
  );
  const [offered, setOffered] = useState<string[]>([]);
  useEffect(() => {
    if (!link) return;
    const stop = link.onStatus((status) => setOffered(status.harnesses));
    void link.connect().catch(() => {});
    return stop;
  }, [link]);
  // What the runner offers; Codex until it has said.
  const harnesses = HARNESSES.filter((h) =>
    offered.length ? offered.includes(h.id) && h.id in PANELS : h.id === "codex",
  );
  const workspace = useHarnessWorkspace(allowed ? project : null);
  const first = harnesses[0]?.id;
  // An empty column opens a conversation instead of asking which.
  useEffect(() => {
    if (allowed && first && workspace.ready && !workspace.tabs.length) workspace.open(first);
  }, [allowed, first, workspace]);
  if (!allowed || !backends)
    return <p className="p-4 text-sm text-muted">{t("agents.ownersAndEditorsOnly")}</p>;
  const history = (backend: HarnessId): HistoryAdapter =>
    backend === "claude"
      ? {
          list: async () => ({
            entries: (await backends.claude.listSessions(project)).map((s) =>
              entry({ ...s, updated: s.updatedAt }),
            ),
          }),
          rename: async (id, title) => {
            await backends.claude.renameSession(project, id, title);
          },
          share: async (id, shared) => {
            await backends.claude.shareSession?.(id, shared);
          },
        }
      : {
          list: async () => ({
            entries: ((await backends.codex.listThreads(project)).data ?? []).map(entry),
          }),
          rename: async (id, title) => {
            await backends.codex.renameThread(id, title);
          },
          share: async (id, shared) => {
            await backends.codex.shareThread?.(id, shared);
          },
        };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {harnesses.length > 1 && (
        <div className="flex shrink-0 items-center border-b border-border px-2 py-1.5">
          <HarnessButtons
            workspace={workspace}
            harnesses={harnesses}
            onChoose={(backend) => workspace.focus(backend)}
          />
        </div>
      )}
      <HarnessWorkspace
        workspace={workspace}
        visible={visible}
        preferredBackend={first ?? "codex"}
        harnesses={harnesses}
        panels={PANELS}
        panelProps={{ codex: { backend: backends.codex }, claude: { backend: backends.claude } }}
        history={history}
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
