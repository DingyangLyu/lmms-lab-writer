/**
 * One comment thread as the web review margin, the sticky notes and the desktop's team
 * comments show it, in the manner of Zotero's annotation cards: who and when, the quoted text
 * under a coloured bar, the comment, replies, and the actions the viewer may take. Names
 * written with @ stand out, and the reply field offers the people to name. The host makes the
 * requests; this component only reports what was asked.
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
import { MentionField, type MentionPerson, personColor, WithMentions } from "./mentions";

export { personColor } from "./mentions";

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
  "flex size-6 items-center justify-center rounded text-muted transition-colors hover:bg-accent-hover hover:text-foreground disabled:opacity-40";
const field =
  "rounded-md border border-border bg-background px-2 py-1.5 text-xs transition-colors focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-300/40";
const button =
  "inline-flex shrink-0 items-center justify-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40";

/** A person's initial in their colour. */
export function Initial({
  id,
  name,
  size = "size-5",
}: {
  id: string;
  name: string;
  size?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex ${size} shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white`}
      style={{ background: personColor(id) }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
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
    <div className="flex min-h-6 items-center gap-1.5">
      <Initial id={id} name={name} />
      <strong className="truncate font-semibold">{name}</strong>
      <span className="shrink-0 text-[11px] text-muted" title={new Date(time).toLocaleString()}>
        {when(time)}
        {edited ? ` · ${t("thread.edited")}` : ""}
      </span>
      <span className="ml-auto flex shrink-0 items-center opacity-60 transition-opacity group-hover/thread:opacity-100 group-focus-within/thread:opacity-100">
        {children}
      </span>
    </div>
  );
}

/** Text that turns into a field with Save and Cancel while it is edited. */
function Editable({
  value,
  editing,
  people,
  onSave,
  onCancel,
}: {
  value: string;
  editing: boolean;
  people: MentionPerson[];
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(value);
  if (!editing)
    return (
      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
        <WithMentions text={value} people={people} />
      </p>
    );
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSave(text);
      }}
    >
      <MentionField
        multiline
        aria-label={t("thread.edit")}
        rows={3}
        value={text}
        onValue={setText}
        people={people}
        autoFocus
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim()) onSave(text);
          if (e.key === "Escape") onCancel();
        }}
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
  people = [],
  pending,
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
  /** The people comments can name with @. */
  people?: MentionPerson[];
  /** Shown before the server has confirmed it. */
  pending?: boolean;
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
    [reply, setReply] = useState(""),
    [sending, setSending] = useState(false);
  const mine = (author: string) => author === me;
  const send = () => {
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    setReply("");
    // The host reports a failure; the typed reply comes back for another try.
    void Promise.resolve(onReply(body))
      .catch(() => setReply((now) => now || body))
      .finally(() => setSending(false));
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the thread is also reached through its buttons.
    <article
      onClick={onActivate}
      data-thread={c.id}
      className={`group/thread space-y-2 rounded-lg border bg-background p-2.5 text-xs shadow-sm transition-[box-shadow,border-color,opacity] duration-150 ${active ? "border-amber-400 shadow-md ring-2 ring-amber-300/40" : "border-border hover:border-foreground/25 hover:shadow"} ${c.resolved ? "opacity-70" : ""} ${pending ? "opacity-80" : ""}`}
    >
      {heading}
      <Byline id={c.author} name={c.authorName} time={c.created} edited={c.edited}>
        {c.pdf ? (
          <span title={t("thread.fromPdf")} className="px-1 text-muted">
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
              <CheckIcon className="size-3.5" weight="bold" />
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
            className={`${iconButton} hover:text-red-600`}
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
      {c.quote && (
        <blockquote className="line-clamp-3 rounded-r-sm border-l-[3px] border-amber-400 bg-amber-50/80 px-2 py-1 leading-snug text-foreground/75 dark:bg-amber-400/10">
          {c.quote}
        </blockquote>
      )}
      <Editable
        key={`${c.id}:${c.body}`}
        value={c.body}
        editing={editing === c.id}
        people={people}
        onCancel={() => setEditing(null)}
        onSave={(body) => {
          setEditing(null);
          onEdit(body);
        }}
      />
      {c.replies.length > 0 && (
        <div className="space-y-2 border-t border-border/70 pt-2">
          {c.replies.map((r) => (
            <div key={r.id} className="space-y-0.5 pl-1">
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
                    className={`${iconButton} hover:text-red-600`}
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
              <div className="pl-[26px]">
                <Editable
                  key={`${r.id}:${r.body}`}
                  value={r.body}
                  editing={editing === r.id}
                  people={people}
                  onCancel={() => setEditing(null)}
                  onSave={(body) => {
                    setEditing(null);
                    onEditReply(r.id, body);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {canComment && !c.resolved && !pending && (active || reply) && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <MentionField
            aria-label={t("thread.replyLabel")}
            value={reply}
            onValue={setReply}
            people={people}
            placeholder={people.length ? t("thread.replyMention") : t("thread.replyPlaceholder")}
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
