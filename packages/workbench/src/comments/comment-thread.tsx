/**
 * One comment thread as the web review margin and the desktop's team comments show it:
 * author, time, quoted text, comment, replies and the actions the viewer may take. The host
 * makes the requests; this component only reports what was asked.
 */
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  FilePdfIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { useWorkbenchI18n as useI18n } from "../i18n";

export type ThreadReply = {
  id: string;
  author: string;
  authorName: string;
  body: string;
  created: number;
  edited: number | null;
};
/** A comment as the collaboration server returns it (the fields a thread shows). */
export type ThreadComment = {
  id: string;
  file: string;
  author: string;
  authorName: string;
  quote: string;
  body: string;
  resolved: boolean;
  created: number;
  edited: number | null;
  /** Offsets and first line in the server's current text; null once the text was deleted. */
  from: number | null;
  to: number | null;
  line: number | null;
  excerpt: string | null;
  pdf: unknown | null;
  replies: ThreadReply[];
};

/** The same colour a person's cursor has in the web editor. */
export const personColor = (id: string) =>
  `hsl(${[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360},65%,42%)`;

function useWhen() {
  const { t, locale } = useI18n();
  return (time: number) => {
    const minutes = Math.round((Date.now() - time) / 60_000);
    if (minutes < 1) return t("thread.justNow");
    const tag = locale === "zh" ? "zh-CN" : "en";
    const format = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
    if (minutes < 60) return format.format(-minutes, "minute");
    if (minutes < 1440) return format.format(-Math.round(minutes / 60), "hour");
    return new Date(time).toLocaleDateString(tag);
  };
}

const iconButton =
  "flex h-5 w-5 items-center justify-center text-muted hover:bg-accent-hover hover:text-foreground disabled:opacity-40";
const field =
  "border border-border bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none";
const button =
  "inline-flex shrink-0 items-center justify-center border px-2 py-1 text-xs transition-colors disabled:opacity-40";

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
        {edited ? ` · ${t("thread.edited")}` : ""}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">{children}</span>
    </div>
  );
}

/** Text that turns into a field with Save and Cancel while it is edited. */
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
      <textarea
        aria-label={t("thread.edit")}
        rows={3}
        value={text}
        // biome-ignore lint/a11y/noAutofocus: editing starts from the Edit button just clicked.
        autoFocus
        onChange={(e) => setText(e.target.value)}
        className={`${field} w-full resize-y p-2`}
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!text.trim()}
          className={`${button} border-foreground bg-foreground text-background`}
        >
          {t("thread.save")}
        </button>
        <button type="button" onClick={onCancel} className={`${button} border-border`}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

export function CommentThread({
  comment: c,
  me,
  canComment,
  canResolve,
  canDeleteAny,
  busy,
  active,
  onActivate,
  heading,
  footer,
  onResolve,
  onEdit,
  onDelete,
  onReply,
  onEditReply,
  onDeleteReply,
}: {
  comment: ThreadComment;
  /** The viewer's user id: authors edit and delete their own words. */
  me: string;
  canComment: boolean;
  /** Resolving is for the author and for editors and owners. */
  canResolve: boolean;
  /** Owners may delete anyone's comment or reply. */
  canDeleteAny: boolean;
  busy?: boolean;
  active?: boolean;
  onActivate?: () => void;
  heading?: ReactNode;
  footer?: ReactNode;
  onResolve: (resolved: boolean) => void;
  onEdit: (body: string) => void;
  onDelete: () => void;
  /** May return a promise; the typed reply is cleared once it resolves. */
  onReply: (body: string) => unknown;
  onEditReply: (id: string, body: string) => void;
  onDeleteReply: (id: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<string | null>(null),
    [reply, setReply] = useState("");
  const mine = (author: string) => author === me;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the thread is also reached through its buttons.
    <article
      onClick={onActivate}
      className={`space-y-2 border bg-background p-2.5 text-xs transition-shadow ${active ? "border-foreground shadow-md" : "border-border"} ${c.resolved ? "opacity-70" : ""}`}
    >
      {heading}
      <Byline id={c.author} name={c.authorName} time={c.created} edited={c.edited}>
        {c.pdf ? (
          <span title={t("thread.fromPdf")} className="text-muted">
            <FilePdfIcon className="size-3.5" />
          </span>
        ) : null}
        {canComment && (mine(c.author) || canResolve) && (
          <button
            type="button"
            className={iconButton}
            disabled={busy}
            title={c.resolved ? t("thread.reopen") : t("thread.resolve")}
            aria-label={c.resolved ? t("thread.reopen") : t("thread.resolve")}
            onClick={(e) => {
              e.stopPropagation();
              onResolve(!c.resolved);
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
            title={t("thread.edit")}
            aria-label={t("thread.edit")}
            onClick={() => setEditing(c.id)}
          >
            <PencilSimpleIcon className="size-3.5" />
          </button>
        )}
        {(mine(c.author) || canDeleteAny) && (
          <button
            type="button"
            className={iconButton}
            disabled={busy}
            title={t("thread.delete")}
            aria-label={t("thread.delete")}
            onClick={() => {
              if (confirm(t("thread.deleteConfirm"))) onDelete();
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
          onEdit(body);
        }}
      />
      {c.replies.map((r) => (
        <div key={r.id} className="space-y-1 border-l-2 border-border pl-2">
          <Byline id={r.author} name={r.authorName} time={r.created} edited={r.edited}>
            {mine(r.author) && (
              <button
                type="button"
                className={iconButton}
                title={t("thread.edit")}
                aria-label={t("thread.edit")}
                onClick={() => setEditing(r.id)}
              >
                <PencilSimpleIcon className="size-3" />
              </button>
            )}
            {(mine(r.author) || canDeleteAny) && (
              <button
                type="button"
                className={iconButton}
                disabled={busy}
                title={t("thread.delete")}
                aria-label={t("thread.delete")}
                onClick={() => {
                  if (confirm(t("thread.deleteReplyConfirm"))) onDeleteReply(r.id);
                }}
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
              onEditReply(r.id, body);
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
            // The host reports a failure; the typed reply stays for another try.
            void Promise.resolve(onReply(body))
              .then(() => setReply(""))
              .catch(() => {});
          }}
        >
          <input
            aria-label={t("thread.replyLabel")}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={t("thread.replyPlaceholder")}
            className={`${field} min-w-0 flex-1`}
          />
          <button
            type="submit"
            disabled={busy || !reply.trim()}
            className={`${button} border-border hover:border-foreground hover:bg-accent-hover`}
          >
            {t("thread.reply")}
          </button>
        </form>
      )}
      {footer}
    </article>
  );
}
