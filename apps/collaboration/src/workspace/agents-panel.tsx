/**
 * The right column: the desktop's AI conversation panels, with the agents running on the lab's
 * shared runner. Conversations belong to the whole project unless whoever started one hides it;
 * their edits land in the shared text (a version is saved before every turn). Conversations
 * another project shows here are read-only.
 */
import { workbenchI18n } from "@lmms-lab/workbench";
import {
  ClaudePanel,
  CodexPanel,
  type EditorSelectionContext,
  HARNESSES,
  HarnessButtons,
  type HarnessId,
  HarnessWorkspace,
  type HistoryAdapter,
  type HistoryEntry,
  OpenCodeClient,
  OpenCodePanel,
  parseChatLink,
  useHarnessWorkspace,
} from "@lmms-lab/workbench/agents";
import { useEffect, useMemo, useState } from "react";
import type { PublicUser, Role } from "../../shared/api";
import { i18n, useI18n } from "../i18n";
import {
  AgentLink,
  OPENCODE_RELAY,
  relayClaudeBackend,
  relayCodexBackend,
  relayOpenCodeTransport,
} from "./agent-link";

const PANELS = { codex: CodexPanel, claude: ClaudePanel, opencode: OpenCodePanel };
const WEB_ORDER: HarnessId[] = ["codex", "claude", "opencode"];
/** Text for the conversation in front, from a button elsewhere on the page. */
export type AiTask = { id: number; text: string };
/** What the server adds to OpenCode's session list: whose conversation it is. */
type Linked = { id: string; name: string } | null;
type Shared = {
  writer?: { mine?: boolean; shared?: boolean; ownerName?: string; linkedFrom?: Linked };
};
/** How a conversation shows in the history: whose it is and whether it is shared. */
const entry = (item: {
  id: string;
  name?: string | null;
  updated?: number;
  mine?: boolean;
  shared?: boolean;
  ownerName?: string;
  linkedFrom?: Linked;
}): HistoryEntry => ({
  id: item.id,
  title: item.name || workbenchI18n.t("codex.untitledConversation"),
  updatedAt: item.updated,
  detail: item.linkedFrom
    ? i18n.t("agents.linkedFrom", { project: item.linkedFrom.name, name: item.ownerName ?? "" })
    : item.mine
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
  selection,
  onSelectionDone,
  task,
  onTaskTaken,
  onOpenFile,
  onError,
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
    () =>
      link && {
        codex: relayCodexBackend(link),
        claude: relayClaudeBackend(link),
        opencode: relayOpenCodeTransport(link),
      },
    [link],
  );
  const [offered, setOffered] = useState<string[]>([]);
  useEffect(() => {
    if (!link) return;
    const stop = link.onStatus((status) => setOffered(status.harnesses));
    void link.connect().catch(() => {});
    return stop;
  }, [link]);
  // What the runner offers, Codex first; Codex until it has said.
  const harnesses = WEB_ORDER.flatMap((id) => HARNESSES.filter((h) => h.id === id)).filter((h) =>
    offered.length ? offered.includes(h.id) : h.id === "codex",
  );
  const workspace = useHarnessWorkspace(allowed ? project : null);
  const first = harnesses[0]?.id;
  // An empty column opens a conversation instead of asking which.
  useEffect(() => {
    if (allowed && first && workspace.ready && !workspace.tabs.length) workspace.open(first);
  }, [allowed, first, workspace]);
  // A task goes to the conversation in front (queued while it works), else a new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per task, when the conversations are known.
  useEffect(() => {
    if (!task || !first || !workspace.ready) return;
    const active = workspace.tabs.find((tab) => tab.id === workspace.activeId);
    try {
      workspace.dispatch({ backend: active?.backend ?? first, tabId: active?.id }, task.text);
    } catch (cause) {
      onError(String(cause));
    }
    onTaskTaken(task.id);
  }, [task, first, workspace.ready]);
  if (!allowed || !backends)
    return <p className="p-4 text-sm text-muted">{t("agents.ownersAndEditorsOnly")}</p>;
  const opencodeHistory = (): HistoryAdapter => {
    const client = new OpenCodeClient({
      baseUrl: OPENCODE_RELAY,
      directory: project,
      transport: backends.opencode,
    });
    return {
      list: async () => ({
        entries: (await client.listHistorySessions()).map((session) =>
          entry({
            id: session.id,
            name: session.title,
            updated: session.time.updated,
            ...(session as Shared).writer,
          }),
        ),
      }),
      rename: async (id, title) => {
        await client.renameSession(id, title);
      },
      share: async (id, shared) => {
        await link?.request("thread.share", { threadId: id, shared });
      },
    };
  };
  const history = (backend: HarnessId): HistoryAdapter =>
    backend === "opencode"
      ? opencodeHistory()
      : backend === "claude"
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
        panelProps={{
          codex: { backend: backends.codex },
          claude: { backend: backends.claude },
          opencode: {
            transport: backends.opencode,
            baseUrl: OPENCODE_RELAY,
            autoConnect: true,
            daemonStatus: "running",
            onShare: (id: string, shared: boolean) =>
              link?.request("thread.share", { threadId: id, shared }),
          },
        }}
        history={history}
        onBackendChange={() => {}}
        shared={{
          directory: project,
          onFileClick: (reference) => {
            const target = projectPath(reference, project);
            if (target) onOpenFile(target.path, target.line ?? 1);
            else onError(t("agents.notInProject", { path: reference }));
          },
          editorSelection: selection?.project === project ? selection : null,
          onClearSelection: () => onSelectionDone(null),
          onSelectionSent: (sent) => onSelectionDone(sent),
          // The shared text is saved as it is typed; the runner copies it before each turn.
          onBeforeSend: async () => {},
        }}
      />
    </div>
  );
}
