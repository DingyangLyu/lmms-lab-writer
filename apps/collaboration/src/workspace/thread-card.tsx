/** The shared comment thread, with the web workspace's requests and permissions. */
import { CommentThread } from "@lmms-lab/workbench";
import { ArrowRightIcon, RobotIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { Comment } from "../../shared/api";
import { ago } from "../dashboard";
import { useI18n } from "../i18n";
import { commentsTask } from "./ai-tasks";
import type { WorkspaceContext } from "./context";

/** The members as the @ field offers them. */
export const peopleOf = (ws: WorkspaceContext) =>
  ws.members.map((m) => ({ id: m.id, name: m.username }));

/** Where the comment was handed: the last AI conversation, by whom and when. */
export function HandoffTag({ comment }: { comment: Comment }) {
  const { t, locale } = useI18n();
  const last = comment.handoffs.at(-1);
  if (!last) return null;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700 dark:bg-violet-400/10 dark:text-violet-300"
      title={comment.handoffs
        .map((h) => `${h.actorName} → ${h.target} · ${new Date(h.created).toLocaleString()}`)
        .join("\n")}
    >
      <RobotIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {t("notes.sentTo", { to: last.target, time: ago(last.created, locale, t("dash.justNow")) })}
      </span>
      {comment.handoffs.length > 1 && <span>×{comment.handoffs.length}</span>}
    </span>
  );
}

export function ThreadCard({
  ws,
  comment,
  active,
  onActivate,
  heading,
  footer,
  noAi,
}: {
  ws: WorkspaceContext;
  comment: Comment;
  active?: boolean;
  onActivate?: () => void;
  heading?: ReactNode;
  footer?: ReactNode;
  /** Where the AI is offered beside the thread instead (the note on the text). */
  noAi?: boolean;
}) {
  const { t, locale } = useI18n();
  const { user, role, canComment, canEdit, askAi, comments: ops } = ws;
  // An open comment can go to the AI as a change to make, as on the desktop.
  const ai = askAi && !noAi && !comment.resolved && !comment.pending && (
    <button
      type="button"
      title={t("comments.askAiTitle")}
      onClick={(event) => {
        event.stopPropagation();
        askAi(commentsTask([comment], ws.files, locale), [comment.id]);
      }}
      className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted transition-colors hover:bg-accent-hover hover:text-foreground"
    >
      <RobotIcon className="size-3.5" aria-hidden="true" />
      {t("comments.askAi")}
      <ArrowRightIcon className="size-3" aria-hidden="true" />
    </button>
  );
  const tags = comment.handoffs.length > 0 && <HandoffTag comment={comment} />;
  return (
    <CommentThread
      comment={comment}
      me={user.id}
      canComment={canComment}
      canResolve={canEdit}
      canDeleteAny={role === "owner"}
      active={active}
      onActivate={onActivate}
      heading={heading}
      people={peopleOf(ws)}
      pending={comment.pending}
      footer={
        footer || ai || tags ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {tags}
            {footer}
            {ai && <span className="ml-auto">{ai}</span>}
          </div>
        ) : undefined
      }
      onResolve={(resolved) => ops.resolve(comment.id, resolved)}
      onEdit={(body) => ops.edit(comment.id, body)}
      onDelete={() => ops.remove(comment.id)}
      onReply={(body) => ops.reply(comment.id, body)}
      onEditReply={(id, body) => ops.editReply(comment.id, id, body)}
      onDeleteReply={(id) => ops.removeReply(comment.id, id)}
    />
  );
}
