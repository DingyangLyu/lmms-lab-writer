import { invoke } from "@tauri-apps/api/core";
import { conversationTitle } from "@/lib/bridge/context";
import { i18n } from "@/lib/i18n";
import { OpenCodeClient } from "@/lib/opencode/client";
import type { HarnessId } from "./types";
export type HistoryEntry = { id: string; title: string; updatedAt?: number };
export type HistoryPage = { entries: HistoryEntry[]; cursor?: string | null };
type Scope = { project: string; baseUrl: string };
type HistoryAdapter = {
  list: (scope: Scope, cursor?: string) => Promise<HistoryPage>;
  rename: (scope: Scope, id: string, title: string) => Promise<void>;
};
export const HISTORY_ADAPTERS: Record<HarnessId, HistoryAdapter> = {
  codex: {
    async list({ project }, cursor) {
      const result = await invoke<{
        data?: Array<{ id: string; name?: string; preview?: string; updatedAt?: number }>;
        nextCursor?: string;
      }>("codex_list_threads", { cwd: project, cursor: cursor || null });
      return {
        entries: (result.data || []).map((t) => ({
          id: t.id,
          title:
            t.name?.trim() ||
            conversationTitle(t.preview) ||
            i18n.t("msg.untitledCodexConversation"),
          updatedAt: t.updatedAt ? t.updatedAt * 1000 : undefined,
        })),
        cursor: result.nextCursor,
      };
    },
    async rename(_scope, id, title) {
      await invoke("codex_rename_thread", { threadId: id, name: title });
    },
  },
  claude: {
    async list({ project }) {
      const entries = await invoke<Array<{ id: string; name: string; updatedAt: number }>>(
        "claude_list_sessions",
        { cwd: project },
      );
      return { entries: entries.map((s) => ({ id: s.id, title: s.name, updatedAt: s.updatedAt })) };
    },
    async rename({ project }, id, title) {
      await invoke("claude_rename_session", { cwd: project, sessionId: id, name: title });
    },
  },
  opencode: {
    async list({ project, baseUrl }) {
      const client = new OpenCodeClient({ baseUrl, directory: project });
      const sessions = await client.listHistorySessions();
      return {
        entries: sessions.map((s) => ({
          id: s.id,
          title: s.title || i18n.t("msg.untitledOpencodeConversation"),
          updatedAt: s.time.updated,
        })),
      };
    },
    async rename({ project, baseUrl }, id, title) {
      await new OpenCodeClient({ baseUrl, directory: project }).renameSession(id, title);
    },
  },
};
