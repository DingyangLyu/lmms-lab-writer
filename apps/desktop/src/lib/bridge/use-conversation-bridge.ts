"use client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
export type Conversation = {
  id: string;
  backend: string;
  project: string;
  title: string;
  busy: boolean;
  enabled: boolean;
  activeJob?: string | null;
  options: Record<string, unknown>;
};
export type BridgeTask = {
  id: string;
  from: string;
  to: string;
  prompt: string;
  status: string;
  result: string;
  callback: string;
  createdAt: number;
};
export type BridgeSnapshot = { conversations: Conversation[]; tasks: BridgeTask[] };
export async function registerConversation(conversation: Conversation) {
  await invoke("writer_register_conversation", { conversation });
}
export function useConversationBridge(
  backend: string,
  id: string | null,
  project: string | undefined,
  title: string,
  busy: boolean,
  options: Record<string, unknown>,
) {
  const [enabled, setEnabled] = useState(true);
  const [snapshot, setSnapshot] = useState<BridgeSnapshot>({ conversations: [], tasks: [] });
  const [error, setError] = useState<string | null>(null);
  const fullId = id ? `${backend}:${id}` : null;
  const encoded = JSON.stringify(options);
  useEffect(() => {
    if (project)
      setEnabled(localStorage.getItem(`writer-bridge-enabled:${backend}:${project}`) !== "false");
  }, [backend, project]);
  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      setSnapshot(await invoke<BridgeSnapshot>("writer_bridge_snapshot", { project }));
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  }, [project]);
  useEffect(() => {
    if (!project || !fullId) return;
    void registerConversation({
      id: fullId,
      backend,
      project,
      title,
      busy,
      enabled,
      options: JSON.parse(encoded),
    })
      .then(refresh)
      .catch((cause) => setError(String(cause)));
  }, [project, fullId, backend, title, busy, enabled, encoded, refresh]);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void listen("writer://bridge-changed", () => void refresh()).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    void refresh();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [refresh]);
  const toggle = () => {
    if (project)
      localStorage.setItem(`writer-bridge-enabled:${backend}:${project}`, String(!enabled));
    setEnabled(!enabled);
  };
  const register = useCallback(
    async (actualId: string) => {
      if (project)
        await registerConversation({
          id: `${backend}:${actualId}`,
          backend,
          project,
          title,
          busy,
          enabled,
          options: JSON.parse(encoded),
        });
    },
    [project, backend, title, busy, enabled, encoded],
  );
  return {
    fullId,
    enabled,
    toggle,
    snapshot,
    error,
    refresh,
    register,
  };
}
