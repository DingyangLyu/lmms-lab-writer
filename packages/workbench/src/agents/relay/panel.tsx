/**
 * The AI conversation column for a project on a Writer server, with the agents running on the
 * server's shared runner: the web app's right column, and the desktop's "on the server" choice
 * for a folder linked to a server project. Conversations belong to the whole project unless
 * whoever started one hides it; their edits land in the shared text (a version is saved
 * before every turn). Conversations another project shows here are read-only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { workbenchI18n as i18n } from "../../i18n";
import { parseChatLink } from "../chat/links";
import { ClaudePanel } from "../claude/claude-panel";
import { CodexPanel } from "../codex/codex-panel";
import { HarnessButtons, HarnessWorkspace } from "../harness/harness-workspace";
import {
  type ConversationTarget,
  HARNESSES,
  type HarnessId,
  type HistoryAdapter,
  type HistoryEntry,
} from "../harness/types";
import { useHarnessWorkspace } from "../harness/use-workspace";
import { OpenCodeClient } from "../opencode/client";
import { OpenCodePanel } from "../opencode/opencode-panel";
import { type AgentPlatform, AgentPlatformScope, agentPlatform } from "../platform";
import type { EditorSelectionContext } from "../selection-context";
import {
  type AgentLink,
  OPENCODE_RELAY,
  relayClaudeBackend,
  relayCodexBackend,
  relayOpenCodeTransport,
} from "./link";

const PANELS = { codex: CodexPanel, claude: ClaudePanel, opencode: OpenCodePanel };
const ORDER: HarnessId[] = ["codex", "claude", "opencode"];
/** Work from the page for an AI conversation: a chosen one, else the one in front. */
export type RelayTask = { id: number; text: string; target?: ConversationTarget };
/** The open conversations, the kinds the runner offers, and the one in front. */
export type RelayConversations = {
  tabs: Array<{ id: string; backend: HarnessId; title: string }>;
  harnesses: HarnessId[];
  active: string | null;
};
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
  title: item.name || i18n.t("codex.untitledConversation"),
  updatedAt: item.updated,
  detail: item.linkedFrom
    ? i18n.t("relay.linkedFrom", { project: item.linkedFrom.name, name: item.ownerName ?? "" })
    : item.mine
      ? i18n.t(item.shared ? "harness.shared" : "harness.private")
      : i18n.t("codex.sharedByName", { name: item.ownerName ?? "" }),
  shared: item.shared,
  mine: item.mine,
});

/** A path the agent printed: relative to the project, or inside the runner's copy of it. */
export function relayProjectPath(reference: string, project: string) {
  const target = parseChatLink(reference.replace(/\\/g, "/"));
  if (target.kind !== "file" && target.kind !== "external-file") return null;
  const marker = `/${project}/`;
  const at = target.path.indexOf(marker);
  const path = at >= 0 ? target.path.slice(at + marker.length) : target.path;
  return path.startsWith("/") || /^[A-Za-z]:/.test(path) ? null : { path, line: target.line };
}

/**
 * The app's platform without what works only on a local folder: the conversations run in the
 * server's copy, which the desktop's bridge, attachment copies and review baseline cannot
 * reach. Images still attach (they travel with the message); other files are refused, as on
 * the web.
 */
export function serverPlatform(app: AgentPlatform): AgentPlatform {
  return {
    openExternal: app.openExternal,
    fileSource: app.fileSource,
    choosePaths: app.choosePaths,
    onDropPaths: app.onDropPaths,
    readImagePath: app.readImagePath,
  };
}

export function RelayAgentsPanel({
  link,
  project,
  workspaceKey = project,
  visible,
  selection,
  onSelectionDone,
  task,
  onTaskTaken,
  onConversations,
  onOpenFile,
  onError,
  onBeforeSend = async () => {},
}: {
  link: AgentLink;
  /** The server's project ID. */
  project: string;
  /** Where the open tabs are remembered; the desktop keeps them apart from its own. */
  workspaceKey?: string;
  visible: boolean;
  /** The editor's selection, offered to the next message as context. */
  selection: EditorSelectionContext | null;
  /** The selection was sent, or its chip removed. */
  onSelectionDone: (sent: EditorSelectionContext | null) => void;
  /** Work from the page (comments to address, a build to fix) for the current conversation. */
  task?: RelayTask | null;
  onTaskTaken?: (id: number) => void;
  /** The open conversations, for choosing where work from the page goes. */
  onConversations?: (conversations: RelayConversations) => void;
  /** A project file the agent linked to, as a path in the project. */
  onOpenFile: (path: string, line: number) => void;
  onError: (message: string) => void;
  /** Before a message goes: the desktop saves and uploads what the agent should see. */
  onBeforeSend?: (selection: EditorSelectionContext | null) => Promise<void>;
}) {
  const backends = useMemo(
    () => ({
      codex: relayCodexBackend(link),
      claude: relayClaudeBackend(link),
      opencode: relayOpenCodeTransport(link),
    }),
    [link],
  );
  const platform = useMemo(() => serverPlatform(agentPlatform()), []);
  const [offered, setOffered] = useState<string[]>([]);
  useEffect(() => {
    const stop = link.onStatus((status) => setOffered(status.harnesses));
    void link.connect().catch(() => {});
    return stop;
  }, [link]);
  // What the runner offers, Codex first; Codex until it has said.
  const harnesses = ORDER.flatMap((id) => HARNESSES.filter((h) => h.id === id)).filter((h) =>
    offered.length ? offered.includes(h.id) : h.id === "codex",
  );
  const workspace = useHarnessWorkspace(workspaceKey);
  const first = harnesses[0]?.id;
  // An empty column opens a conversation instead of asking which.
  useEffect(() => {
    if (first && workspace.ready && !workspace.tabs.length) workspace.open(first);
  }, [first, workspace]);
  const reported = useRef("");
  useEffect(() => {
    if (!onConversations || !workspace.ready) return;
    const next: RelayConversations = {
      tabs: workspace.tabs.map((tab) => ({ id: tab.id, backend: tab.backend, title: tab.title })),
      harnesses: harnesses.map((h) => h.id),
      active: workspace.activeId,
    };
    const key = JSON.stringify(next);
    if (key === reported.current) return;
    reported.current = key;
    onConversations(next);
  });
  // A task goes to the conversation chosen for it, else the one in front (queued while it
  // works), else a new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per task, when the conversations are known.
  useEffect(() => {
    if (!task || !first || !workspace.ready) return;
    const active = workspace.tabs.find((tab) => tab.id === workspace.activeId);
    const chosen = task.target;
    const open = chosen?.tabId && workspace.tabs.find((tab) => tab.id === chosen.tabId);
    const target = open
      ? { backend: open.backend, tabId: open.id }
      : chosen && !chosen.tabId && harnesses.some((h) => h.id === chosen.backend)
        ? { backend: chosen.backend }
        : { backend: active?.backend ?? first, tabId: active?.id };
    try {
      workspace.dispatch(target, task.text);
    } catch (cause) {
      onError(String(cause));
    }
    onTaskTaken?.(task.id);
  }, [task, first, workspace.ready]);
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
        await link.request("thread.share", { threadId: id, shared });
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
    <AgentPlatformScope platform={platform}>
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
                link.request("thread.share", { threadId: id, shared }),
            },
          }}
          history={history}
          onBackendChange={() => {}}
          shared={{
            directory: project,
            onFileClick: (reference) => {
              const target = relayProjectPath(reference, project);
              if (target) onOpenFile(target.path, target.line ?? 1);
              else onError(i18n.t("relay.notInProject", { path: reference }));
            },
            editorSelection: selection?.project === project ? selection : null,
            onClearSelection: () => onSelectionDone(null),
            onSelectionSent: (sent) => onSelectionDone(sent),
            // The runner copies the server's text before each turn.
            onBeforeSend,
          }}
        />
      </div>
    </AgentPlatformScope>
  );
}
