/** The shared comment thread, with the web workspace's requests and permissions. */
import { CommentThread } from "@lmms-lab/workbench";
import type { ReactNode } from "react";
import type { Comment } from "../../shared/api";
import { api, errorText } from "../api";
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
  const { prefix, user, role, canComment, canEdit, busy, run, reload } = ws;
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
      footer={footer}
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
