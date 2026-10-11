/**
 * Every comment of the project as a column of sticky notes on the right, opened from the
 * header: open and resolved ones (the history), filters and search, the comment being written
 * when it has no place beside the text, and several notes at once handed to a chosen AI
 * conversation, as in the desktop's comment manager.
 */
import {
  CaretDownIcon,
  ChatCircleTextIcon,
  CheckCircleIcon,
  CrosshairIcon,
  NoteIcon,
  RobotIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { Comment } from "../../shared/api";
import { ago } from "../dashboard";
import { useI18n } from "../i18n";
import { AiTargetSelect } from "./ai-target";
import { commentsTask } from "./ai-tasks";
import type { WorkspaceContext } from "./context";
import type { CommentDraft } from "./notes";
import { DraftCard } from "./review-margin";
import { ThreadCard } from "./thread-card";
import { Btn, Input, onTop } from "./ui";

/** Where a comment is: its file and line, and the PDF page it was made on. */
export function noteWhere(ws: WorkspaceContext, c: Comment, t: ReturnType<typeof useI18n>["t"]) {
  const path = ws.files.find((f) => f.id === c.file)?.path ?? "";
  const page = c.pdf?.marks[0]?.page;
  return [
    c.line ? `${path}:${c.line}` : `${path} · ${t("notes.unanchored")}`,
    page ? t("notes.pdfPage", { page }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One sticky note: where, the quoted text, the request; open it for the whole thread. */
export function NoteItem({
  ws,
  comment: c,
  selected,
  onSelect,
  expanded,
  onToggle,
  onLocate,
}: {
  ws: WorkspaceContext;
  comment: Comment;
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  expanded: boolean;
  onToggle: () => void;
  onLocate?: () => void;
}) {
  const { t, locale } = useI18n();
  const sent = ws.ai.sent[c.id];
  const justNow = t("dash.justNow");
  return (
    <article
      className={`border border-l-[3px] ${c.resolved ? "border-border border-l-emerald-500/70 bg-background" : "border-amber-200 border-l-amber-400 bg-amber-50/70"}`}
    >
      <div className="flex items-start gap-2 p-2">
        {onSelect && (
          <input
            type="checkbox"
            aria-label={t("notes.selected", { count: 1 })}
            checked={!!selected}
            disabled={c.resolved}
            onChange={(event) => onSelect(event.target.checked)}
            className="mt-0.5 shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-[11px] text-muted">
            <span className="truncate">{noteWhere(ws, c, t)}</span>
            <span className="ml-auto shrink-0">{ago(c.created, locale, justNow)}</span>
          </div>
          {!expanded && (
            <button type="button" onClick={onToggle} className="block w-full text-left">
              {c.quote && (
                <span className="mt-1 line-clamp-2 border-l-2 border-amber-300 pl-1.5 text-muted">
                  {c.quote}
                </span>
              )}
              <span className="mt-1 line-clamp-3 whitespace-pre-wrap">{c.body}</span>
            </button>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
            <span>{c.authorName}</span>
            {c.replies.length > 0 && <span>{t("notes.replies", { count: c.replies.length })}</span>}
            {c.resolved && (
              <span className="inline-flex items-center gap-0.5 text-emerald-700">
                <CheckCircleIcon weight="fill" className="size-3" />
                {t("notes.resolvedTag")}
              </span>
            )}
            {sent && (
              <span className="truncate" title={sent.to}>
                {t("notes.sentTo", { to: sent.to, time: ago(sent.at, locale, justNow) })}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-muted">
            {onLocate && c.line && (
              <button
                type="button"
                className="inline-flex items-center gap-1 hover:text-foreground"
                onClick={onLocate}
              >
                <CrosshairIcon className="size-3.5" />
                {t("comments.locate")}
              </button>
            )}
            {ws.askAi && !c.resolved && (
              <button
                type="button"
                title={t("comments.askAiTitle")}
                className="inline-flex items-center gap-1 hover:text-foreground"
                onClick={() => ws.askAi?.(commentsTask([c], ws.files, locale), [c.id])}
              >
                <RobotIcon className="size-3.5" />
                {t("comments.askAi")}
              </button>
            )}
            <button type="button" className="ml-auto hover:text-foreground" onClick={onToggle}>
              {expanded ? t("notes.collapse") : t("notes.expand")}
            </button>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-amber-200 p-2">
          <ThreadCard ws={ws} comment={c} active />
        </div>
      )}
    </article>
  );
}

export function CommentsPanel({
  ws,
  comments,
  open,
  setOpen,
  draft,
  setDraft,
  onSubmit,
  showDraft,
  onLocate,
}: {
  ws: WorkspaceContext;
  comments: Comment[];
  open: boolean;
  setOpen: (open: boolean) => void;
  draft: CommentDraft | null;
  setDraft: (draft: CommentDraft | null) => void;
  onSubmit: () => void;
  /** Whether the draft is written here (it has no place beside the text). */
  showDraft: boolean;
  onLocate: (comment: Comment) => void;
}) {
  const { t, locale } = useI18n();
  const button = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all"),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [expanded, setExpanded] = useState<string | null>(null);
  const pending = comments.filter((c) => !c.resolved),
    resolved = comments.filter((c) => c.resolved);
  const needle = query.trim().toLowerCase();
  const shown = comments.filter(
    (c) =>
      (filter === "all" || (filter === "resolved") === c.resolved) &&
      (!needle ||
        `${c.body} ${c.quote} ${c.authorName} ${c.replies.map((r) => r.body).join(" ")}`
          .toLowerCase()
          .includes(needle)),
  );
  // Open ones first, newest first within each.
  const ordered = [...shown].sort(
    (a, b) => Number(a.resolved) - Number(b.resolved) || b.created - a.created,
  );
  const chosen = pending.filter((c) => selected.has(c.id));
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target as HTMLElement).closest?.(".cm-editor"))
        setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  const path = (id: string) => ws.files.find((f) => f.id === id)?.path ?? "";
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 border border-border px-2 text-xs hover:border-foreground hover:bg-accent-hover"
      >
        <ChatCircleTextIcon className="size-4 sm:hidden" aria-hidden="true" />
        <span className="sm:hidden">{pending.length}</span>
        <span className="hidden sm:inline">
          {t("shell.commentsCount", { count: pending.length })}
        </span>
        {resolved.length > 0 && (
          <span className="hidden items-center gap-1 text-emerald-600 sm:flex">
            <CheckCircleIcon weight="fill" className="size-3.5" />
            {resolved.length}
          </span>
        )}
        {draft && <span className="text-orange-600">{t("shell.draft")}</span>}
        <CaretDownIcon
          className={`hidden size-3 transition-transform sm:block ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open &&
        onTop(
          <aside
            aria-label={t("notes.column")}
            className="fixed top-12 right-0 bottom-0 z-[150] flex w-[22rem] max-w-[94vw] flex-col border-l border-border bg-background text-xs text-foreground shadow-xl"
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <NoteIcon className="size-4 text-amber-500" weight="fill" aria-hidden="true" />
              <strong>{t("notes.column")}</strong>
              <span className="mr-auto truncate text-muted">
                {t("shell.commentCounts", { open: pending.length, resolved: resolved.length })}
              </span>
              <button
                type="button"
                aria-label={t("common.close")}
                onClick={() => setOpen(false)}
                className="p-1 hover:text-accent"
              >
                <XIcon className="size-4" />
              </button>
            </header>
            <div className="shrink-0 space-y-2 border-b border-border px-3 py-2">
              <div className="flex gap-1">
                {(
                  [
                    ["all", t("shell.filterAll", { count: comments.length })],
                    ["open", t("shell.filterOpen", { count: pending.length })],
                    ["resolved", t("shell.filterResolved", { count: resolved.length })],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={`border px-2 py-0.5 ${filter === value ? "border-foreground bg-foreground text-background" : "border-border hover:bg-accent-hover"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Input
                aria-label={t("shell.searchComments")}
                placeholder={t("shell.searchComments")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full"
              />
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2">
              {draft && showDraft && (
                <DraftCard
                  ws={ws}
                  draft={draft}
                  setDraft={setDraft}
                  onSubmit={onSubmit}
                  heading={t("shell.newCommentOn", { path: path(draft.file) })}
                />
              )}
              {!ordered.length && (
                <p className="py-5 text-center text-muted">
                  {comments.length ? t("shell.noMatchingComments") : t("shell.noComments")}
                </p>
              )}
              {ordered.map((c) => (
                <NoteItem
                  key={c.id}
                  ws={ws}
                  comment={c}
                  selected={selected.has(c.id)}
                  onSelect={
                    ws.askAi
                      ? (on) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (on) next.add(c.id);
                            else next.delete(c.id);
                            return next;
                          })
                      : undefined
                  }
                  expanded={expanded === c.id}
                  onToggle={() => setExpanded((id) => (id === c.id ? null : c.id))}
                  onLocate={() => onLocate(c)}
                />
              ))}
            </div>
            {ws.askAi && pending.length > 0 && (
              <footer className="shrink-0 space-y-2 border-t border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="border border-border px-2 py-0.5 hover:bg-accent-hover"
                    onClick={() =>
                      setSelected(new Set(ordered.filter((c) => !c.resolved).map((c) => c.id)))
                    }
                  >
                    {t("notes.selectVisible")}
                  </button>
                  <span className="text-muted">
                    {t("notes.selected", { count: chosen.length })}
                  </span>
                  {chosen.length > 0 && (
                    <button
                      type="button"
                      className="ml-auto text-muted hover:text-foreground"
                      onClick={() => setSelected(new Set())}
                    >
                      {t("notes.clear")}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <AiTargetSelect
                    value={ws.ai.choice}
                    onChange={ws.ai.setChoice}
                    conversations={ws.ai.conversations}
                    className="flex-1"
                  />
                  <Btn
                    tone="solid"
                    disabled={!chosen.length}
                    title={t("notes.sendSelectedTitle")}
                    onClick={() => {
                      ws.askAi?.(
                        commentsTask(chosen, ws.files, locale),
                        chosen.map((c) => c.id),
                      );
                      setSelected(new Set());
                    }}
                  >
                    {t("notes.sendSelected", { count: chosen.length })}
                  </Btn>
                </div>
              </footer>
            )}
          </aside>,
        )}
    </>
  );
}
