/**
 * One comment thread: author, time, text, replies and the actions each member may take —
 * reply and resolve (commenters and up), edit (the author), delete (the author or an owner).
 */
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  FilePdfIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import type { Comment, Reply } from "../../shared/api";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { Btn, Input, TextArea } from "./ui";

/** The same colour a person's cursor has in the editor. */
export const personColor = (id: string) =>
  `hsl(${[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360},65%,42%)`;

export function useWhen() {
  const { t, locale } = useI18n();
  return (time: number) => {
    const minutes = Math.round((Date.now() - time) / 60_000);
    if (minutes < 1) return t("notes.justNow");
    const format = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", {
      numeric: "auto",
    });
    if (minutes < 60) return format.format(-minutes, "minute");
    if (minutes < 1440) return format.format(-Math.round(minutes / 60), "hour");
    return new Date(time).toLocaleDateString(locale === "zh" ? "zh-CN" : "en");
  };
}

function Byline({
  id,
  name,
  time,
  edited,
  children,
}: {
  id: string;
  name: string;
  time: number;
  edited: number | null;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const when = useWhen();
  return (
    <div className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="flex h-4 w-4 shrink-0 items-center justify-center text-[9px] font-medium text-white"
        style={{ background: personColor(id) }}
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
      <strong className="truncate font-medium">{name}</strong>
      <span className="shrink-0 text-muted" title={new Date(time).toLocaleString()}>
        {when(time)}
        {edited ? ` · ${t("notes.edited")}` : ""}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">{children}</span>
    </div>
  );
}

/** Text that becomes a field with Save and Cancel while it is being edited. */
function Editable({
  value,
  editing,
  onSave,
  onCancel,
}: {
  value: string;
  editing: boolean;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(value);
  if (!editing) return <p className="whitespace-pre-wrap break-words">{value}</p>;
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSave(text);
      }}
    >
      <TextArea
        aria-label={t("notes.edit")}
        rows={3}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2">
        <Btn type="submit" tone="solid" disabled={!text.trim()}>
          {t("common.save")}
        </Btn>
        <Btn onClick={onCancel}>{t("common.cancel")}</Btn>
      </div>
    </form>
  );
}

const iconButton =
  "flex h-5 w-5 items-center justify-center text-muted hover:bg-accent-hover hover:text-foreground disabled:opacity-40";

export function ThreadCard({
  ws,
  comment: c,
  active,
  onActivate,
  heading,
  footer,
}: {
  ws: WorkspaceContext;
  comment: Comment;
  active?: boolean;
  onActivate?: () => void;
  /** Shown above the text, e.g. the file in the full list. */
  heading?: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<string | null>(null),
    [reply, setReply] = useState("");
  const { prefix, user, role, canComment, canEdit, busy, run, reload } = ws;
  const mine = (author: string) => author === user.id;
  const act = (request: () => Promise<unknown>) =>
    run(async () => {
      await request();
      await reload();
    });
  const removeReply = (r: Reply) => {
    if (confirm(t("notes.deleteReplyConfirm")))
      act(() => api(`${prefix}/replies/${r.id}`, {}, "DELETE"));
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the thread is selected with its buttons too.
    <article
      onClick={onActivate}
      className={`space-y-2 border bg-background p-2.5 text-xs transition-shadow ${active ? "border-foreground shadow-md" : "border-border"} ${c.resolved ? "opacity-70" : ""}`}
    >
      {heading}
      <Byline id={c.author} name={c.authorName} time={c.created} edited={c.edited}>
        {c.pdf && (
          <span title={t("notes.fromPdf")} className="text-muted">
            <FilePdfIcon className="size-3.5" />
          </span>
        )}
        {canComment && (mine(c.author) || canEdit) && (
          <button
            type="button"
            className={iconButton}
            disabled={busy}
            title={c.resolved ? t("comments.reopen") : t("comments.resolve")}
            aria-label={c.resolved ? t("comments.reopen") : t("comments.resolve")}
            onClick={(e) => {
              e.stopPropagation();
              act(() => api(`${prefix}/comments/${c.id}`, { resolved: !c.resolved }, "PATCH"));
            }}
          >
            {c.resolved ? (
              <ArrowCounterClockwiseIcon className="size-3.5" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
          </button>
        )}
        {mine(c.author) && (
          <button
            type="button"
            className={iconButton}
            title={t("notes.edit")}
            aria-label={t("notes.edit")}
            onClick={() => setEditing(c.id)}
          >
            <PencilSimpleIcon className="size-3.5" />
          </button>
        )}
        {(mine(c.author) || role === "owner") && (
          <button
            type="button"
            className={iconButton}
            disabled={busy}
            title={t("notes.delete")}
            aria-label={t("notes.delete")}
            onClick={() => {
              if (confirm(t("notes.deleteConfirm")))
                act(() => api(`${prefix}/comments/${c.id}`, {}, "DELETE"));
            }}
          >
            <TrashIcon className="size-3.5" />
          </button>
        )}
      </Byline>
      <blockquote className="line-clamp-2 border-l-2 border-orange-400 pl-2 text-muted">
        {c.quote}
      </blockquote>
      <Editable
        key={`${c.id}:${c.body}`}
        value={c.body}
        editing={editing === c.id}
        onCancel={() => setEditing(null)}
        onSave={(body) => {
          setEditing(null);
          act(() => api(`${prefix}/comments/${c.id}`, { body }, "PATCH"));
        }}
      />
      {c.replies.map((r) => (
        <div key={r.id} className="space-y-1 border-l-2 border-border pl-2">
          <Byline id={r.author} name={r.authorName} time={r.created} edited={r.edited}>
            {mine(r.author) && (
              <button
                type="button"
                className={iconButton}
                title={t("notes.edit")}
                aria-label={t("notes.edit")}
                onClick={() => setEditing(r.id)}
              >
                <PencilSimpleIcon className="size-3" />
              </button>
            )}
            {(mine(r.author) || role === "owner") && (
              <button
                type="button"
                className={iconButton}
                disabled={busy}
                title={t("notes.delete")}
                aria-label={t("notes.delete")}
                onClick={() => removeReply(r)}
              >
                <TrashIcon className="size-3" />
              </button>
            )}
          </Byline>
          <Editable
            key={`${r.id}:${r.body}`}
            value={r.body}
            editing={editing === r.id}
            onCancel={() => setEditing(null)}
            onSave={(body) => {
              setEditing(null);
              act(() => api(`${prefix}/replies/${r.id}`, { body }, "PATCH"));
            }}
          />
        </div>
      ))}
      {canComment && !c.resolved && (active || reply) && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const body = reply;
            act(async () => {
              await api(`${prefix}/comments/${c.id}/reply`, { body });
              setReply("");
            });
          }}
        >
          <Input
            aria-label={t("comments.replyLabel")}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={t("comments.replyPlaceholder")}
            className="min-w-0 flex-1"
          />
          <Btn type="submit" disabled={busy || !reply.trim()}>
            {t("comments.reply")}
          </Btn>
        </form>
      )}
      {footer}
    </article>
  );
}
