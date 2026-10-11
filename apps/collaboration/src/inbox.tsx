/**
 * The member's inbox, on every page: who named them with @ in a comment, and replies in the
 * threads they take part in. It looks again every minute, when the window comes back into
 * view, and at once when an open project says something arrived.
 */
import { personColor } from "@lmms-lab/workbench";
import { AtIcon, ChatsCircleIcon, ChecksIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { Inbox, Notice } from "../shared/api";
import { api } from "./api";
import { ago } from "./dashboard";
import { useI18n } from "./i18n";

/** Fired by an open project's connection when something arrives (see use-project). */
export const INBOX_EVENT = "writer-inbox";
const EVERY = 60_000;

export function useInbox() {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const refresh = useCallback(async () => {
    try {
      setInbox(await api<Inbox>("/notifications"));
    } catch {
      /* Shown again on the next look. */
    }
  }, []);
  useEffect(() => {
    void refresh();
    const look = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(look, EVERY);
    window.addEventListener(INBOX_EVENT, look);
    document.addEventListener("visibilitychange", look);
    return () => {
      clearInterval(timer);
      window.removeEventListener(INBOX_EVENT, look);
      document.removeEventListener("visibilitychange", look);
    };
  }, [refresh]);
  /** Marks the notices read (all of them without ids), shown at once. */
  const markRead = useCallback((ids?: string[]) => {
    setInbox((current) =>
      current
        ? {
            items: current.items.map((n) =>
              !ids || ids.includes(n.id) ? { ...n, read: true } : n,
            ),
            unread: ids ? current.items.filter((n) => !n.read && !ids.includes(n.id)).length : 0,
          }
        : current,
    );
    void api("/notifications/read", ids ? { ids } : {}).catch(() => {});
  }, []);
  return { inbox, refresh, markRead };
}

/** The notices, newest first; a click opens the comment (and marks it read). */
export function InboxList({
  inbox,
  onOpen,
  onReadAll,
  project,
}: {
  inbox: Inbox | null;
  onOpen: (notice: Notice) => void;
  onReadAll: () => void;
  /** The project open now: its notices do not repeat its name. */
  project?: string;
}) {
  const { t, locale } = useI18n();
  if (!inbox) return <p className="p-4 text-center text-xs text-muted">{t("common.loading")}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-muted">
          {inbox.unread ? t("inbox.unread", { count: inbox.unread }) : t("inbox.allRead")}
        </span>
        {inbox.unread > 0 && (
          <button
            type="button"
            onClick={onReadAll}
            className="ml-auto inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-muted hover:bg-accent-hover hover:text-foreground"
          >
            <ChecksIcon className="size-3.5" aria-hidden="true" />
            {t("inbox.readAll")}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!inbox.items.length && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted">
            <AtIcon className="size-8 opacity-40" aria-hidden="true" />
            <p>{t("inbox.empty")}</p>
          </div>
        )}
        {inbox.items.map((n, i) => (
          <button
            key={n.id}
            type="button"
            onClick={() => onOpen(n)}
            style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }}
            className={`fade-up flex w-full gap-2.5 border-0 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-accent-hover ${n.read ? "bg-transparent" : "bg-sky-50/70 dark:bg-sky-400/5"}`}
          >
            <span className="relative mt-0.5 shrink-0">
              <span
                aria-hidden="true"
                className="flex size-7 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                style={{ background: personColor(n.actor) }}
              >
                {n.actorName.slice(0, 1).toUpperCase()}
              </span>
              {!n.read && (
                <span
                  className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-sky-500 ring-2 ring-background"
                  role="img"
                  aria-label={t("inbox.new")}
                />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                {n.kind === "mention" ? (
                  <AtIcon className="size-3.5 shrink-0 text-sky-600" aria-hidden="true" />
                ) : (
                  <ChatsCircleIcon
                    className="size-3.5 shrink-0 text-amber-600"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0 truncate">
                  <strong className="font-semibold">{n.actorName}</strong>{" "}
                  {n.kind === "mention" ? t("inbox.mentioned") : t("inbox.replied")}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-muted">
                  {ago(n.created, locale, t("dash.justNow"))}
                </span>
              </span>
              {n.project !== project && (
                <span className="block truncate text-[11px] text-muted">{n.projectName}</span>
              )}
              <span className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-foreground">
                {n.body}
              </span>
              {n.quote && (
                <span className="mt-1 line-clamp-1 border-l-2 border-amber-400 pl-1.5 text-muted">
                  {n.quote}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
