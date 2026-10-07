import { useState } from "react";
import type { Comment } from "../../shared/api";
import { api } from "../api";
import type { Selection } from "../editor";
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
  const [reply, setReply] = useState<Record<string, string>>({});
  const { prefix, file, files, busy, canComment, run, reload } = ws;
  return (
    <>
      <h2>讨论与批注</h2>
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
            aria-label="批注内容"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="提出修改建议…"
            required
          />
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={busy || !canComment || ws.status !== "saved"}
            >
              发布批注
            </button>
            <button type="button" onClick={() => setSelection(null)}>
              收起
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
            <span>{c.resolved ? "✓ 已解决" : "待处理"}</span> · {c.authorName}
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
                  ws.notify("已打开批注文档，再点“定位”跳转。");
                } else ws.editor.current?.focusComment(c);
              }}
            >
              定位
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
              {c.resolved ? "重新打开" : "标为已解决"}
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
                aria-label="回复批注"
                value={reply[c.id] || ""}
                onChange={(e) => setReply({ ...reply, [c.id]: e.target.value })}
                placeholder="回复…"
                required
              />
              <button type="submit" disabled={busy}>
                回复
              </button>
            </form>
          )}
        </details>
      ))}
    </>
  );
}
