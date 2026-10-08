import { i18n } from "@/lib/i18n";
import {
  type ConversationInfo,
  type ConversationTab,
  type HarnessId,
  harnessLabel,
  isHarnessId,
} from "./types";
export type WorkspaceState = {
  tabs: ConversationTab[];
  activeId: string | null;
  lastActive?: Partial<Record<HarnessId, string>>;
};
export const EMPTY_WORKSPACE: WorkspaceState = { tabs: [], activeId: null };
/** The "New … conversation" title of a tab before its session has one, in either language. */
const isPlaceholderTitle = (title: string) => /^(新 .+ 对话|New .+ conversation)$/.test(title);

export function newTab(
  backend: HarnessId,
  sessionId: string | null = null,
  title?: string,
): ConversationTab {
  return {
    id: crypto.randomUUID(),
    backend,
    sessionId,
    title: title || i18n.t("msg.newNameConversation", { name: harnessLabel(backend) }),
    status: "connecting",
    hasDraft: false,
    queued: 0,
  };
}
export function restoreWorkspace(raw: string | null): WorkspaceState {
  try {
    const parsed = JSON.parse(raw || "null");
    if (!Array.isArray(parsed?.tabs)) return EMPTY_WORKSPACE;
    const seen = new Set<string>();
    const tabs: ConversationTab[] = [];
    for (const t of parsed.tabs) {
      if (
        !t ||
        typeof t.id !== "string" ||
        !isHarnessId(t.backend) ||
        (t.sessionId !== null && typeof t.sessionId !== "string")
      )
        continue;
      if (t.sessionId === null && t.pending !== true && t.draft !== true) continue;
      const key = t.sessionId ? `${t.backend}:${t.sessionId}` : t.id;
      if (seen.has(key) || tabs.some((tab) => tab.id === t.id)) continue;
      seen.add(key);
      tabs.push({
        id: t.id,
        backend: t.backend,
        sessionId: t.sessionId,
        title: typeof t.title === "string" ? t.title : harnessLabel(t.backend),
        status: "connecting",
        // Protected until the panel reloads its persisted composer draft.
        hasDraft: t.draft === true,
        queued: 0,
      });
    }
    return {
      tabs,
      lastActive: Object.fromEntries(
        ["opencode", "codex", "claude"].flatMap((backend) => {
          const id = parsed.lastActive?.[backend];
          return tabs.some((t) => t.backend === backend && t.id === id) ? [[backend, id]] : [];
        }),
      ),
      activeId: tabs.find((t) => t.id === parsed.activeId)?.id || tabs[0]?.id || null,
    };
  } catch {
    return EMPTY_WORKSPACE;
  }
}
export function updateConversation(
  state: WorkspaceState,
  id: string,
  info: ConversationInfo,
): WorkspaceState {
  const previous = state.tabs.find((t) => t.id === id);
  if (previous?.sessionId && info.status === "connecting") {
    info = {
      ...info,
      sessionId: info.sessionId || previous.sessionId,
      title: isPlaceholderTitle(info.title) ? previous.title : info.title,
    };
  }
  if (
    !previous ||
    Object.entries(info).every(([key, value]) => previous[key as keyof ConversationInfo] === value)
  )
    return state;
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...info } : t)) };
}
export function canClose(tab: ConversationTab) {
  return (
    !["running", "waiting", "connecting"].includes(tab.status) && !tab.hasDraft && tab.queued === 0
  );
}

/** An untouched placeholder is UI state, not a native conversation or history entry. */
export function isDisposableDraft(tab: ConversationTab, pendingIds: ReadonlySet<string>) {
  return (
    tab.sessionId === null &&
    !tab.hasDraft &&
    tab.queued === 0 &&
    !pendingIds.has(tab.id) &&
    !["running", "waiting"].includes(tab.status)
  );
}
export function openConversation(
  state: WorkspaceState,
  backend: HarnessId,
  sessionId: string | null,
  title: string | undefined,
  pendingIds: ReadonlySet<string>,
): WorkspaceState {
  const existing = sessionId
    ? state.tabs.find((t) => t.backend === backend && t.sessionId === sessionId)
    : state.tabs.find((t) => t.backend === backend && isDisposableDraft(t, pendingIds));
  const tab = existing || newTab(backend, sessionId, title);
  return {
    ...state,
    lastActive: { ...state.lastActive, [backend]: tab.id },
    tabs: [
      ...state.tabs.filter((t) => t.id === tab.id || !isDisposableDraft(t, pendingIds)),
      ...(existing ? [] : [tab]),
    ],
    activeId: tab.id,
  };
}
export function serializeWorkspace(state: WorkspaceState, pendingIds: ReadonlySet<string>) {
  const tabs = state.tabs
    .filter((t) => t.sessionId || pendingIds.has(t.id) || t.hasDraft)
    .map((t) => ({ ...t, pending: pendingIds.has(t.id), draft: t.hasDraft }));
  return JSON.stringify({
    lastActive: state.lastActive,
    tabs,
    activeId: tabs.some((t) => t.id === state.activeId) ? state.activeId : tabs.at(-1)?.id || null,
  });
}

export function focusConversation(
  state: WorkspaceState,
  backend: HarnessId,
): WorkspaceState | null {
  const tab =
    state.tabs.find((t) => t.id === state.activeId && t.backend === backend) ||
    state.tabs.find((t) => t.id === state.lastActive?.[backend] && t.backend === backend) ||
    state.tabs.findLast((t) => t.backend === backend);
  return tab
    ? { ...state, activeId: tab.id, lastActive: { ...state.lastActive, [backend]: tab.id } }
    : null;
}
