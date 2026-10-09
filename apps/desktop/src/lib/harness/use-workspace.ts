"use client";
import {
  type ConversationTab,
  useHarnessWorkspace as useSharedWorkspace,
} from "@lmms-lab/workbench/agents";
import { invoke } from "@tauri-apps/api/core";

/** A closed tab's conversation leaves the cross-conversation bridge first. */
async function unregister(tab: ConversationTab, project: string | null | undefined) {
  if (tab.sessionId)
    await invoke("writer_unregister_conversation", {
      project,
      id: `${tab.backend}:${tab.sessionId}`,
    });
}
export function useHarnessWorkspace(project?: string | null) {
  return useSharedWorkspace(project, unregister);
}
