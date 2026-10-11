/**
 * Every comment of the project as a list of note cards in the left panel: open and resolved
 * ones (the history), filters (mentioning me, handed to an AI) and search, the comment being
 * written when it has no place beside the text, and several notes at once handed to a chosen
 * AI conversation, as in the desktop's comment manager.
 */

import { Initial, mentionedIn, WithMentions } from "@lmms-lab/workbench";
import {
  CheckCircleIcon,
  CrosshairIcon,
  NoteIcon,
  QuestionIcon,
  RobotIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { Comment } from "../../shared/api";
import { ago } from "../dashboard";
import { useI18n } from "../i18n";
import { AiTargetSelect } from "./ai-target";
import { commentsTask } from "./ai-tasks";
import type { WorkspaceContext } from "./context";
import type { CommentDraft } from "./notes";
import { DraftCard } from "./review-margin";
import { HandoffTag, peopleOf, ThreadCard } from "./thread-card";
import { Btn, Input } from "./ui";

/** Where a comment is: its file and line, and the PDF page it was made on. */
export function noteWhere(ws: WorkspaceContext, c: Comment, t: ReturnType<typeof useI18n>["t"]) {
  const path = ws.files.find((f) => f.id === c.file)?.path ?? "";
  const page = c.pdf?.marks[0]?.page;
  return [
    c.line ? `${path}:${c.line}` : c.pending ? path : `${path} · ${t("notes.unanchored")}`,
    page ? t("notes.pdfPage", { page }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One note card: where, the quoted text, the request; open it for the whole thread. */
export function NoteItem({
  ws,
  comment: c,
  selected,
  onSelect,
  expanded,
  onToggle,
  onLocate,
  index = 0,
}: {
  ws: WorkspaceContext;
  comment: Comment;
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  expanded: boolean;
  onToggle: () => void;
  onLocate?: () => void;
  /** Its place in the list, for a staggered entrance. */
  index?: number;
}) {
  const { t, locale } = useI18n();
  const people = peopleOf(ws);
  const named = mentionedIn([c.body, ...c.replies.map((r) => r.body)].join("\n"), people);
  if (expanded)
    return (
      <div className="space-y-1">
        <ThreadCard ws={ws} comment={c} active />
        <button
          type="button"
          onClick={onToggle}
          className="w-full rounded-md py-0.5 text-center text-[11px] text-muted hover:bg-accent-hover hover:text-foreground"
        >
          {t("notes.collapse")}
        </button>
      </div>
    );
  return (
    <article
      style={{ animationDelay: `${Math.min(index, 10) * 20}ms` }}
      className={`fade-up group rounded-lg border bg-background text-xs shadow-sm transition-[border-color,box-shadow] hover:shadow ${selected ? "border-amber-400 ring-2 ring-amber-300/40" : "border-border hover:border-foreground/25"} ${c.resolved ? "opacity-75" : ""}`}
    >
      <div className="flex items-start gap-2 p-2.5">
        {onSelect && (
          <input
            type="checkbox"
            aria-label={t("notes.selected", { count: 1 })}
            checked={!!selected}
            disabled={c.resolved}
            onChange={(event) => onSelect(event.target.checked)}
            className="mt-0.5 shrink-0 accent-amber-500"
          />
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <NoteIcon
              className={`size-3.5 shrink-0 ${c.resolved ? "text-emerald-500" : "text-amber-500"}`}
              weight="fill"
              aria-hidden="true"
            />
            {onLocate && c.line ? (
              <button
                type="button"
                title={t("comments.locate")}
                onClick={onLocate}
                className="inline-flex min-w-0 items-center gap-1 truncate hover:text-foreground hover:underline"
              >
                <span className="truncate">{noteWhere(ws, c, t)}</span>
                <CrosshairIcon className="size-3 shrink-0 opacity-0 group-hover:opacity-100" />
              </button>
            ) : (
              <span className="truncate">{noteWhere(ws, c, t)}</span>
            )}
            <span className="ml-auto shrink-0">{ago(c.created, locale, t("dash.justNow"))}</span>
          </div>
          <button type="button" onClick={onToggle} className="block w-full space-y-1.5 text-left">
            {c.quote && (
              <span className="line-clamp-2 rounded-r-sm border-l-[3px] border-amber-400 bg-amber-50/80 px-2 py-0.5 leading-snug text-foreground/75 dark:bg-amber-400/10">
                {c.quote}
              </span>
            )}
            <span className="line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed">
              <WithMentions text={c.body} people={people} />
            </span>
          </button>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1">
              <Initial id={c.author} name={c.authorName} size="size-4" />
              {c.authorName}
            </span>
            {c.replies.length > 0 && (
              <button type="button" onClick={onToggle} className="hover:text-foreground">
                {t("notes.replies", { count: c.replies.length })}
              </button>
            )}
            {c.resolved && (
              <span className="inline-flex items-center gap-0.5 text-emerald-700">
                <CheckCircleIcon weight="fill" className="size-3" />
                {t("notes.resolvedTag")}
              </span>
            )}
            {named.length > 0 && (
              <span className="inline-flex items-center gap-1" title={t("comments.toPeople")}>
                {named.map((p) => (
                  <span
                    key={p.id}
                    className="rounded-full bg-sky-50 px-1.5 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300"
                  >
                    @{p.name}
                  </span>
                ))}
              </span>
            )}
          </div>
          {(c.handoffs.length > 0 || (ws.askAi && !c.resolved && !c.pending)) && (
            <div className="flex items-center gap-2">
              <HandoffTag comment={c} />
              {ws.askAi && !c.resolved && !c.pending && (
                <button
                  type="button"
                  title={t("comments.askAiTitle")}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted hover:bg-accent-hover hover:text-foreground"
                  onClick={() => ws.askAi?.(commentsTask([c], ws.files, locale), [c.id])}
                >
                  <RobotIcon className="size-3.5" />
                  {t("comments.askAi")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

type Filter = "all" | "open" | "resolved" | "mine" | "ai";

/** The comments panel of the left rail. */
export function CommentsList({
  ws,
  comments,
  draft,
  setDraft,
  onSubmit,
  showDraft,
  onLocate,
}: {
  ws: WorkspaceContext;
  comments: Comment[];
  draft: CommentDraft | null;
  setDraft: (draft: CommentDraft | null) => void;
  onSubmit: () => void;
  /** Whether the draft is written here (it has no place beside the text). */
  showDraft: boolean;
  onLocate: (comment: Comment) => void;
}) {
  const { t, locale } = useI18n();
  const [filter, setFilter] = useState<Filter>("open"),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [expanded, setExpanded] = useState<string | null>(null),
    [help, setHelp] = useState(false);
  const me = ws.members.find((m) => m.id === ws.user.id);
  const mentionsMe = (c: Comment) =>
    !!me &&
    mentionedIn([c.body, ...c.replies.map((r) => r.body)].join("\n"), [
      { id: me.id, name: me.username },
    ]).length > 0;
  const pending = comments.filter((c) => !c.resolved),
    resolved = comments.filter((c) => c.resolved),
    mine = comments.filter(mentionsMe),
    toAi = comments.filter((c) => c.handoffs.length > 0);
  const needle = query.trim().toLowerCase();
  const shown = comments.filter(
    (c) =>
      (filter === "all" ||
        (filter === "open" && !c.resolved) ||
        (filter === "resolved" && c.resolved) ||
        (filter === "mine" && mentionsMe(c)) ||
        (filter === "ai" && c.handoffs.length > 0)) &&
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
  const path = (id: string) => ws.files.find((f) => f.id === id)?.path ?? "";
  const chip = (value: Filter, label: string) => (
    <button
      key={value}
      type="button"
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
      className={`shrink-0 rounded-full border px-2 py-0.5 transition-colors ${filter === value ? "border-foreground bg-foreground text-background" : "border-border hover:bg-accent-hover"}`}
    >
      {label}
    </button>
  );
  return (
    <section aria-label={t("notes.column")} className="flex min-h-0 flex-1 flex-col text-xs">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <NoteIcon className="size-4 text-amber-500" weight="fill" aria-hidden="true" />
        <strong>{t("rail.comments")}</strong>
        <span className="truncate text-muted">
          {t("shell.commentCounts", { open: pending.length, resolved: resolved.length })}
        </span>
        <button
          type="button"
          aria-expanded={help}
          title={t("comments.howTitle")}
          aria-label={t("comments.howTitle")}
          onClick={() => setHelp((v) => !v)}
          className="ml-auto rounded p-0.5 text-muted hover:bg-accent-hover hover:text-foreground"
        >
          <QuestionIcon className="size-4" />
        </button>
      </header>
      {help && (
        <p className="pop-in shrink-0 border-b border-border bg-amber-50/70 px-3 py-2 leading-relaxed text-foreground/80 dark:bg-amber-400/10">
          {t("comments.how")}
        </p>
      )}
      <div className="shrink-0 space-y-2 border-b border-border px-3 py-2">
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          {chip("open", t("shell.filterOpen", { count: pending.length }))}
          {chip("all", t("shell.filterAll", { count: comments.length }))}
          {chip("resolved", t("shell.filterResolved", { count: resolved.length }))}
          {mine.length > 0 && chip("mine", t("comments.filterMine", { count: mine.length }))}
          {toAi.length > 0 && chip("ai", t("comments.filterAi", { count: toAi.length }))}
        </div>
        <Input
          type="search"
          aria-label={t("shell.searchComments")}
          placeholder={t("shell.searchComments")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-md"
        />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain bg-surface-secondary/40 p-2">
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
          <p className="py-6 text-center text-muted">
            {comments.length ? t("shell.noMatchingComments") : t("notes.empty")}
          </p>
        )}
        {ordered.map((c, i) => (
          <NoteItem
            key={c.id}
            ws={ws}
            comment={c}
            index={i}
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
              className="rounded-md border border-border px-2 py-0.5 hover:bg-accent-hover"
              onClick={() =>
                setSelected(new Set(ordered.filter((c) => !c.resolved).map((c) => c.id)))
              }
            >
              {t("notes.selectVisible")}
            </button>
            <span className="text-muted">{t("notes.selected", { count: chosen.length })}</span>
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
              className="min-w-0 flex-1"
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
    </section>
  );
}
