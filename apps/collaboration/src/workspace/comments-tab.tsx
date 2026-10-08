import { useState } from "react";
import type { Comment } from "../../shared/api";
import { api } from "../api";
import type { Selection } from "../editor";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";

export function CommentsTab({
  ws,
  comments,
  selection,
  setSelection,
  draft,
  setDraft,
}: {
  ws: WorkspaceContext;
  comments: Comment[];
  selection: Selection | null;
  setSelection: (selection: Selection | null) => void;
  draft: string;
  setDraft: (draft: string) => void;
}) {
  const { t } = useI18n();
  const [reply, setReply] = useState<Record<string, string>>({});
  const { prefix, file, files, busy, canComment, run, reload } = ws;
  return (
    <>
      <h2>{t("comments.title")}</h2>
      {selection && (
        <form
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
          <blockquote>{selection.quote}</blockquote>
          <textarea
            aria-label={t("comments.body")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("comments.placeholder")}
            required
          />
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={busy || !canComment || ws.status !== "saved"}
            >
              {t("comments.post")}
            </button>
            <button type="button" onClick={() => setSelection(null)}>
              {t("comments.collapse")}
            </button>
          </div>
        </form>
      )}
      {comments.map((c) => (
        <details
          key={c.id}
          className={`comment ${c.resolved ? "resolved" : ""}`}
          open={!c.resolved}
        >
          <summary>
            <span>{c.resolved ? t("comments.resolved") : t("comments.open")}</span> · {c.authorName}
          </summary>
          <blockquote>{c.quote}</blockquote>
          <p>{c.body}</p>
          <div className="row">
            <button
              type="button"
              onClick={() => {
                const target = files.find((f) => f.id === c.file);
                if (target && file?.id !== target.id) {
                  ws.openFile(target);
                  ws.notify(t("comments.openedFile"));
                } else ws.editor.current?.focusComment(c);
              }}
            >
              {t("comments.locate")}
            </button>
            <button
              type="button"
              disabled={busy || !canComment}
              onClick={() =>
                run(async () => {
                  await api(`${prefix}/comments/${c.id}`, { resolved: !c.resolved }, "PATCH");
                  await reload();
                })
              }
            >
              {c.resolved ? t("comments.reopen") : t("comments.resolve")}
            </button>
          </div>
          {c.replies.map((r) => (
            <p className="reply" key={r.id}>
              <strong>{r.authorName}</strong> {r.body}
            </p>
          ))}
          {canComment && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await api(`${prefix}/comments/${c.id}/reply`, { body: reply[c.id] || "" });
                  setReply({ ...reply, [c.id]: "" });
                  await reload();
                });
              }}
            >
              <input
                aria-label={t("comments.replyLabel")}
                value={reply[c.id] || ""}
                onChange={(e) => setReply({ ...reply, [c.id]: e.target.value })}
                placeholder={t("comments.replyPlaceholder")}
                required
              />
              <button type="submit" disabled={busy}>
                {t("comments.reply")}
              </button>
            </form>
          )}
        </details>
      ))}
    </>
  );
}
