/**
 * Comments in the status bar, as the desktop's comment history: a counter button opening a
 * panel with the comment being written, filters, search and every thread with its replies.
 */
import {
  CaretDownIcon,
  CheckCircleIcon,
  CircleIcon,
  CrosshairIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { Comment } from "../../shared/api";
import { api } from "../api";
import type { Selection } from "../editor";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { Btn, Input, Popover, TextArea } from "./ui";

export function CommentsPanel({
  ws,
  comments,
  open,
  setOpen,
  selection,
  setSelection,
  draft,
  setDraft,
}: {
  ws: WorkspaceContext;
  comments: Comment[];
  open: boolean;
  setOpen: (open: boolean) => void;
  selection: Selection | null;
  setSelection: (selection: Selection | null) => void;
  draft: string;
  setDraft: (draft: string) => void;
}) {
  const { t, locale } = useI18n();
  const button = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all"),
    [query, setQuery] = useState(""),
    [reply, setReply] = useState<Record<string, string>>({});
  const { prefix, file, files, busy, canComment, run, reload } = ws;
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
  const path = (id: string) => files.find((f) => f.id === id)?.path ?? "";
  const time = (ms: number) => new Date(ms).toLocaleString(locale === "zh" ? "zh-CN" : "en");
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex shrink-0 items-center gap-1.5 border border-border px-2 py-1 hover:border-foreground"
      >
        <span>{t("shell.commentsCount", { count: pending.length })}</span>
        {resolved.length > 0 && (
          <span className="flex items-center gap-1 text-emerald-600">
            <CheckCircleIcon weight="fill" className="size-3.5" />
            {resolved.length}
          </span>
        )}
        {selection && <span className="text-orange-600">{t("shell.draft")}</span>}
        <CaretDownIcon className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
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
        <div className="min-h-0 overflow-y-auto overscroll-contain p-3">
          {selection && (
            <form
              aria-label={t("shell.newComment")}
              className="mb-3 space-y-2 border border-orange-400 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!file) return;
                run(async () => {
                  await api(`${prefix}/comments`, { file: file.id, ...selection, body: draft });
                  setDraft("");
                  setSelection(null);
                  await reload();
                });
              }}
            >
              <div className="flex justify-between gap-2">
                <strong>{t("shell.newCommentOn", { path: file?.path ?? "" })}</strong>
                <button type="button" onClick={() => setSelection(null)}>
                  {t("shell.discardDraft")}
                </button>
              </div>
              <blockquote className="max-h-16 overflow-auto border-l-2 border-orange-400 pl-2 text-muted">
                {selection.quote}
              </blockquote>
              <TextArea
                aria-label={t("comments.body")}
                rows={3}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("comments.placeholder")}
                required
              />
              <Btn
                type="submit"
                tone="solid"
                disabled={busy || !canComment || !draft.trim() || ws.status !== "saved"}
              >
                {t("comments.post")}
              </Btn>
            </form>
          )}
          {!shown.length && (
            <p className="py-5 text-center text-muted">
              {comments.length ? t("shell.noMatchingComments") : t("shell.noComments")}
            </p>
          )}
          {shown.map((c) => (
            <article
              key={c.id}
              className={`mb-2 border ${c.resolved ? "border-emerald-200" : "border-border"}`}
            >
              <div className="flex items-start gap-2 px-3 py-2">
                {c.resolved ? (
                  <CheckCircleIcon
                    weight="fill"
                    className="mt-0.5 size-4 shrink-0 text-emerald-600"
                  />
                ) : (
                  <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted" />
                )}
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className={c.resolved ? "text-emerald-700" : ""}>{c.authorName}</strong>
                    <span className="text-muted">
                      {path(c.file)} · {time(c.created)}
                    </span>
                  </div>
                  <blockquote className="max-h-20 overflow-auto border-l-2 border-border pl-2 text-muted">
                    {c.quote}
                  </blockquote>
                  <p className="whitespace-pre-wrap break-words">{c.body}</p>
                  {c.replies.map((r) => (
                    <p
                      key={r.id}
                      className="whitespace-pre-wrap break-words border-l-2 border-border pl-2"
                    >
                      <strong>{r.authorName}</strong>{" "}
                      <span className="text-muted">{time(r.created)}</span>
                      <br />
                      {r.body}
                    </p>
                  ))}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-accent"
                      onClick={() => {
                        const target = files.find((f) => f.id === c.file);
                        if (target && file?.id !== target.id) {
                          ws.openFile(target);
                          ws.notify(t("comments.openedFile"));
                        } else ws.editor.current?.focusComment(c);
                        setOpen(false);
                      }}
                    >
                      <CrosshairIcon className="size-3.5" />
                      {t("comments.locate")}
                    </button>
                    <button
                      type="button"
                      disabled={busy || !canComment}
                      className={c.resolved ? "" : "text-emerald-700"}
                      onClick={() =>
                        run(async () => {
                          await api(
                            `${prefix}/comments/${c.id}`,
                            { resolved: !c.resolved },
                            "PATCH",
                          );
                          await reload();
                        })
                      }
                    >
                      {c.resolved ? t("comments.reopen") : t("comments.resolve")}
                    </button>
                  </div>
                  {canComment && (
                    <form
                      className="flex gap-2 pt-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(async () => {
                          await api(`${prefix}/comments/${c.id}/reply`, {
                            body: reply[c.id] || "",
                          });
                          setReply({ ...reply, [c.id]: "" });
                          await reload();
                        });
                      }}
                    >
                      <Input
                        aria-label={t("comments.replyLabel")}
                        value={reply[c.id] || ""}
                        onChange={(e) => setReply({ ...reply, [c.id]: e.target.value })}
                        placeholder={t("comments.replyPlaceholder")}
                        className="min-w-0 flex-1"
                        required
                      />
                      <Btn type="submit" disabled={busy}>
                        {t("comments.reply")}
                      </Btn>
                    </form>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </Popover>
    </>
  );
}
