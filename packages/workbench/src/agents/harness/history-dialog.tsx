"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkbenchI18n as useI18n } from "../../i18n";
import { RenameChat } from "../chat/rename-chat";
import {
  HARNESSES,
  type Harness,
  type HarnessId,
  type HistoryAdapter,
  type HistoryEntry,
  harnessLabel,
} from "./types";
export function HistoryDialog({
  backend,
  adapter,
  harnesses = HARNESSES,
  onBackend,
  onOpen,
  onClose,
  onRename,
}: {
  backend: HarnessId;
  adapter: HistoryAdapter;
  harnesses?: readonly Harness[];
  onBackend: (id: HarnessId) => void;
  onOpen: (id: string, title: string) => void;
  onClose: () => void;
  onRename: (id: string, title: string) => void;
}) {
  const { t } = useI18n();
  const ready = adapter.ready !== false;
  // Hosts build the adapter while rendering; only a change of backend reloads the list.
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const [entries, setEntries] = useState<HistoryEntry[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [search, setSearch] = useState("");
  const request = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new backend means a new list.
  const load = useCallback(
    async (next?: string) => {
      const revision = ++request.current;
      setLoading(true);
      setError("");
      try {
        const page = await adapterRef.current.list(next);
        if (revision !== request.current) return;
        setEntries((previous) =>
          next
            ? [
                ...previous,
                ...page.entries.filter((entry) => !previous.some((e) => e.id === entry.id)),
              ]
            : page.entries,
        );
        setCursor(page.cursor || null);
      } catch (cause) {
        if (revision === request.current) setError(String(cause));
      } finally {
        if (revision === request.current) setLoading(false);
      }
    },
    [backend],
  );
  useEffect(() => {
    setEntries([]);
    setCursor(null);
    setSearch("");
    setError("");
    if (!ready) return;
    void load();
    return () => {
      request.current++;
    };
  }, [load, ready]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  const query = search.trim().toLocaleLowerCase();
  const filtered = entries.filter((e) => `${e.title} ${e.id}`.toLocaleLowerCase().includes(query));
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/25 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("harness.conversationHistory")}
        className="flex max-h-[80vh] w-full max-w-xl flex-col border border-border bg-background shadow-xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <strong className="text-sm">{t("harness.conversationHistory")}</strong>
          <button type="button" aria-label={t("harness.closeHistory")} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="flex shrink-0 gap-1 border-b border-border p-2">
          {harnesses.map((h) => (
            <button
              type="button"
              key={h.id}
              aria-pressed={h.id === backend}
              className={`border px-3 py-1 text-xs ${h.id === backend ? "border-foreground bg-foreground text-background" : "border-border"}`}
              onClick={() => onBackend(h.id)}
            >
              {h.label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 gap-2 p-3">
          <input
            aria-label={t("harness.searchConversations")}
            placeholder={t("harness.searchNamesOrSessionIds")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={loading || !ready}
            className="border border-border px-2 py-1 text-xs"
            onClick={() => void load()}
          >
            {t("harness.refresh")}
          </button>
        </div>
        {error && (
          <p role="alert" className="px-3 pb-2 text-xs text-accent">
            {error}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!ready ? (
            <p className="p-5 text-sm text-muted">
              {t("harness.connectingToOpencodeTheHistoryAppearsOnc")}
            </p>
          ) : loading && !entries.length ? (
            <p className="p-5 text-sm text-muted">
              {t("harness.loadingNameHistory", { name: harnessLabel(backend) })}
            </p>
          ) : !filtered.length ? (
            <p className="p-5 text-sm text-muted">
              {query
                ? t("harness.noMatchingConversations")
                : t("harness.noConversationsWithSentMessagesYetEmptyO")}
            </p>
          ) : (
            filtered.map((entry) => (
              <div
                key={entry.id}
                className="group flex items-center gap-2 border-t border-border px-3 py-2 hover:bg-accent-hover"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left group-has-[input]:hidden"
                  title={`${entry.title}\n${entry.id}`}
                  onClick={() => onOpen(entry.id, entry.title)}
                >
                  <span className="block truncate text-sm font-medium">{entry.title}</span>
                  <span className="block truncate text-[10px] text-muted">
                    {entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : ""} ·{" "}
                    {entry.detail ?? entry.id}
                  </span>
                </button>
                {adapter.share && entry.mine && (
                  <button
                    type="button"
                    aria-pressed={!!entry.shared}
                    title={
                      entry.shared
                        ? t("harness.sharedWithTheProjectClickToMakeItPrivate")
                        : t("harness.onlyYouCanSeeThisConversationClickToShar")
                    }
                    className={`shrink-0 border px-2 py-0.5 text-[11px] group-has-[input]:hidden ${entry.shared ? "border-accent text-accent" : "border-border text-muted"}`}
                    onClick={() => {
                      const shared = !entry.shared;
                      void adapter.share?.(entry.id, shared).then(
                        () =>
                          setEntries((current) =>
                            current.map((e) => (e.id === entry.id ? { ...e, shared } : e)),
                          ),
                        (cause) => setError(String(cause)),
                      );
                    }}
                  >
                    {entry.shared ? t("harness.shared") : t("harness.private")}
                  </button>
                )}
                {(entry.mine ?? true) && (
                  <RenameChat
                    name={entry.title}
                    onRename={async (title) => {
                      await adapterRef.current.rename(entry.id, title);
                      setEntries((current) =>
                        current.map((e) => (e.id === entry.id ? { ...e, title } : e)),
                      );
                      onRename(entry.id, title);
                    }}
                  />
                )}
              </div>
            ))
          )}
        </div>
        <footer className="flex shrink-0 items-center justify-between border-t border-border p-3 text-xs text-muted">
          <span>{t("harness.onlyThisProjectSConversationsAreShownOpe")}</span>
          {cursor && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(cursor)}
              className="border border-border px-2 py-1"
            >
              {loading ? t("harness.loading") : t("harness.more")}
            </button>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
