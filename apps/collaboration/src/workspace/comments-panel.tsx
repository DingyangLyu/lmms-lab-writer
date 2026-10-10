/**
 * Every comment of the project from the header, as the desktop's comment history: a
 * counter opening a panel with filters, search and each thread, plus the comment being written
 * when the review margin is not showing it.
 */
import {
  CaretDownIcon,
  ChatCircleTextIcon,
  CheckCircleIcon,
  CrosshairIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { Comment } from "../../shared/api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import type { CommentDraft } from "./notes";
import { DraftCard } from "./review-margin";
import { ThreadCard } from "./thread-card";
import { Input, Popover } from "./ui";

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
  /** Whether the draft is written here (no review margin beside the editor). */
  showDraft: boolean;
  onLocate: (comment: Comment) => void;
}) {
  const { t } = useI18n();
  const button = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all"),
    [query, setQuery] = useState("");
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
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        label={t("comments.title")}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <strong>{t("comments.title")}</strong>
          <span className="mr-auto text-muted">
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
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
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
              className={`border px-2 py-1 ${filter === value ? "border-foreground bg-foreground text-background" : "border-border"}`}
            >
              {label}
            </button>
          ))}
          <span className="flex-1" />
          <Input
            aria-label={t("shell.searchComments")}
            placeholder={t("shell.searchComments")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-44"
          />
        </div>
        <div className="min-h-0 space-y-2 overflow-y-auto overscroll-contain p-3">
          {draft && showDraft && (
            <DraftCard
              ws={ws}
              draft={draft}
              setDraft={setDraft}
              onSubmit={onSubmit}
              heading={t("shell.newCommentOn", { path: path(draft.file) })}
            />
          )}
          {!shown.length && (
            <p className="py-5 text-center text-muted">
              {comments.length ? t("shell.noMatchingComments") : t("shell.noComments")}
            </p>
          )}
          {shown.map((c) => (
            <ThreadCard
              key={c.id}
              ws={ws}
              comment={c}
              active
              heading={
                <div className="flex items-center gap-2 text-[11px] text-muted">
                  <span className="truncate">
                    {path(c.file)}
                    {c.line ? `:${c.line}` : ` · ${t("notes.unanchored")}`}
                  </span>
                  {c.line && (
                    <button
                      type="button"
                      className="ml-auto inline-flex shrink-0 items-center gap-1 hover:text-foreground"
                      onClick={() => {
                        onLocate(c);
                        setOpen(false);
                      }}
                    >
                      <CrosshairIcon className="size-3.5" />
                      {t("comments.locate")}
                    </button>
                  )}
                </div>
              }
            />
          ))}
        </div>
      </Popover>
    </>
  );
}
