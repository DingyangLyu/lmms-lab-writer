"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { workbenchI18n as i18n } from "../../i18n";
import { randomId } from "../../random-id";
import { pruneComposerDrafts } from "../chat/composer-drafts";
import type {
  ConversationInfo,
  ConversationTab,
  ConversationTarget,
  HarnessId,
  IncomingMessage,
} from "./types";
import {
  canClose,
  EMPTY_WORKSPACE,
  focusConversation,
  isDisposableDraft,
  openConversation,
  restoreWorkspace,
  serializeWorkspace,
  updateConversation,
  type WorkspaceState,
} from "./workspace";

/**
 * The conversation tabs of a project, kept in this browser. `beforeClose` lets the desktop
 * unregister a conversation from its bridge before the tab goes.
 */
export function useHarnessWorkspace(
  project?: string | null,
  beforeClose?: (tab: ConversationTab, project: string | null | undefined) => Promise<void>,
) {
  const beforeCloseRef = useRef(beforeClose);
  beforeCloseRef.current = beforeClose;
  const [state, setState] = useState<WorkspaceState>(EMPTY_WORKSPACE);
  const [loadedProject, setLoadedProject] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<Record<string, IncomingMessage[]>>({});
  const [error, setError] = useState("");
  const pendingRef = useRef(incoming);
  pendingRef.current = incoming;
  const latest = useRef(state);
  latest.current = state;
  const projectRef = useRef(project);
  projectRef.current = project;
  const commit = useCallback((next: WorkspaceState) => {
    latest.current = next;
    setState(next);
  }, []);
  useEffect(() => {
    const restoredTabs = restoreWorkspace(
      project ? localStorage.getItem(`writer-conversations:${project}`) : null,
    );
    commit(restoredTabs);
    if (project)
      void pruneComposerDrafts(project, new Set(restoredTabs.tabs.map((t) => t.id))).catch(
        () => {},
      );
    let restored: Record<string, IncomingMessage[]> = {};
    try {
      const saved = JSON.parse(
        project ? localStorage.getItem(`writer-dispatch:${project}`) || "{}" : "{}",
      );
      restored = Object.fromEntries(
        Object.entries(saved)
          .filter(([, list]) => Array.isArray(list))
          .map(([id, list]) => [
            id,
            (list as IncomingMessage[])
              .filter((m) => typeof m?.id === "string" && typeof m.text === "string")
              .map((m) => ({ ...m, state: "paused" })),
          ]),
      );
    } catch {
      /* Saved chat history remains available if a pending dispatch was corrupt. */
    }
    setIncoming(restored);
    setLoadedProject(project || null);
    setError("");
  }, [project, commit]);
  useEffect(() => {
    if (!project || loadedProject !== project) return;
    try {
      localStorage.setItem(
        `writer-conversations:${project}`,
        serializeWorkspace(
          state,
          new Set(
            Object.entries(incoming)
              .filter(([, list]) => list.length)
              .map(([id]) => id),
          ),
        ),
      );
    } catch {
      setError(i18n.t("msg.couldNotSaveTheConversationTabsDoNotClos"));
    }
  }, [state, incoming, project, loadedProject]);
  const saveIncoming = useCallback((next: Record<string, IncomingMessage[]>) => {
    const project = projectRef.current;
    if (!project) throw new Error(i18n.t("msg.openAProjectFirst"));
    localStorage.setItem(`writer-dispatch:${project}`, JSON.stringify(next));
    pendingRef.current = next;
    setIncoming(next);
  }, []);
  const open = useCallback(
    (backend: HarnessId, sessionId: string | null = null, title?: string) => {
      const next = openConversation(
        latest.current,
        backend,
        sessionId,
        title,
        new Set(
          Object.entries(pendingRef.current)
            .filter(([, list]) => list.length)
            .map(([id]) => id),
        ),
      );
      commit(next);
      return next.activeId as string;
    },
    [commit],
  );
  const focus = useCallback(
    (backend: HarnessId) => {
      const next = focusConversation(latest.current, backend);
      if (next) {
        commit(next);
        return next.activeId as string;
      }
      const project = projectRef.current;
      const remembered =
        backend === "codex"
          ? localStorage.getItem(`lmms-writer-codex-thread:${project}`)
          : backend === "claude"
            ? localStorage.getItem(`writer-claude-session:${project}`)
            : null;
      return open(backend, remembered);
    },
    [commit, open],
  );
  const select = useCallback(
    (id: string) => {
      if (latest.current.tabs.some((t) => t.id === id)) {
        const pendingIds = new Set(
          Object.entries(pendingRef.current)
            .filter(([, items]) => items.length)
            .map(([key]) => key),
        );
        const selected = latest.current.tabs.find((t) => t.id === id);
        commit({
          ...latest.current,
          lastActive: selected
            ? { ...latest.current.lastActive, [selected.backend]: id }
            : latest.current.lastActive,
          tabs: latest.current.tabs.filter(
            (tab) => tab.id === id || !isDisposableDraft(tab, pendingIds),
          ),
          activeId: id,
        });
      }
    },
    [commit],
  );
  const update = useCallback(
    (id: string, info: ConversationInfo) => commit(updateConversation(latest.current, id, info)),
    [commit],
  );
  const close = useCallback(
    async (id: string) => {
      const current = latest.current;
      const tab = current.tabs.find((t) => t.id === id);
      if (!tab || !canClose(tab)) return;
      try {
        await beforeCloseRef.current?.(tab, projectRef.current);
      } catch (cause) {
        setError(String(cause));
        return;
      }
      const tabs = latest.current.tabs.filter((t) => t.id !== id);
      commit({
        ...latest.current,
        tabs,
        activeId:
          latest.current.activeId === id ? tabs.at(-1)?.id || null : latest.current.activeId,
      });
    },
    [commit],
  );
  const dispatch = useCallback(
    (target: ConversationTarget, text: string) => {
      const existing =
        target.tabId &&
        latest.current.tabs.find((t) => t.id === target.tabId && t.backend === target.backend);
      if (target.tabId && !existing)
        throw new Error(i18n.t("msg.theTargetConversationWasClosedChooseAnot"));
      const id = existing ? existing.id : open(target.backend);
      select(id);
      saveIncoming({
        ...pendingRef.current,
        [id]: [...(pendingRef.current[id] || []), { id: randomId(), text, state: "pending" }],
      });
      return id;
    },
    [open, select, saveIncoming],
  );
  const accept = useCallback(
    (tabId: string, id: string) => {
      saveIncoming({
        ...pendingRef.current,
        [tabId]: (pendingRef.current[tabId] || []).filter((m) => m.id !== id),
      });
    },
    [saveIncoming],
  );
  const retry = useCallback(
    (tabId: string) => {
      saveIncoming({
        ...pendingRef.current,
        [tabId]: (pendingRef.current[tabId] || []).map((m, i) =>
          i || m.state === "sending" ? m : { ...m, id: randomId(), state: "pending" },
        ),
      });
    },
    [saveIncoming],
  );
  const deliveryState = useCallback(
    (tabId: string, id: string, state: IncomingMessage["state"]) => {
      saveIncoming({
        ...pendingRef.current,
        [tabId]: (pendingRef.current[tabId] || []).map((m) => (m.id === id ? { ...m, state } : m)),
      });
    },
    [saveIncoming],
  );
  return {
    ...state,
    ready: Boolean(project) && loadedProject === project,
    incoming,
    error,
    open,
    focus,
    select,
    update,
    close,
    dispatch,
    accept,
    retry,
    deliveryState,
  };
}
