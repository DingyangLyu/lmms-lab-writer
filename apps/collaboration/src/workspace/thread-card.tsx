/** The shared comment thread, with the web workspace's requests and permissions. */
import { CommentThread } from "@lmms-lab/workbench";
import { RobotIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { Comment } from "../../shared/api";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";
import { commentsTask } from "./ai-tasks";
import type { WorkspaceContext } from "./context";

export function ThreadCard({
  ws,
  comment,
  active,
  onActivate,
  heading,
  footer,
}: {
  ws: WorkspaceContext;
  comment: Comment;
  active?: boolean;
  onActivate?: () => void;
  heading?: ReactNode;
  footer?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const { prefix, user, role, canComment, canEdit, busy, run, reload, askAi } = ws;
  // An open comment can go to the AI as a change to make, as on the desktop.
  const ai = askAi && !comment.resolved && (
    <button
      type="button"
      title={t("comments.askAiTitle")}
      onClick={(event) => {
        event.stopPropagation();
        askAi(commentsTask([comment], ws.files, locale));
      }}
      className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
    >
      <RobotIcon className="size-3.5" aria-hidden="true" />
      {t("comments.askAi")}
    </button>
  );
  const act = (request: () => Promise<unknown>) =>
    run(async () => {
      await request();
      await reload();
    });
  return (
    <CommentThread
      comment={comment}
      me={user.id}
      canComment={canComment}
      canResolve={canEdit}
      canDeleteAny={role === "owner"}
      busy={busy}
      active={active}
      onActivate={onActivate}
      heading={heading}
      footer={
        footer || ai ? (
          <>
            {footer}
            {ai}
          </>
        ) : undefined
      }
      onResolve={(resolved) =>
        act(() => api(`${prefix}/comments/${comment.id}`, { resolved }, "PATCH"))
      }
      onEdit={(body) => act(() => api(`${prefix}/comments/${comment.id}`, { body }, "PATCH"))}
      onDelete={() => act(() => api(`${prefix}/comments/${comment.id}`, {}, "DELETE"))}
      onReply={(body) =>
        // Returned, so the shared thread keeps the typed reply if posting fails.
        api(`${prefix}/comments/${comment.id}/reply`, { body })
          .then(reload)
          .catch((error) => {
            ws.report(errorText(error));
            throw error;
          })
      }
      onEditReply={(id, body) => act(() => api(`${prefix}/replies/${id}`, { body }, "PATCH"))}
      onDeleteReply={(id) => act(() => api(`${prefix}/replies/${id}`, {}, "DELETE"))}
    />
  );
}
