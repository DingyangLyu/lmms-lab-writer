import { useState } from "react";
import type { Proposal } from "../../shared/api";
import { api } from "../api";
import type { WorkspaceContext } from "./context";

const decisionLabel = { accepted: "接受", rejected: "拒绝", pending: "撤销决定" } as const;
const statusLabel = { accepted: "✓ 已接受", rejected: "已拒绝", pending: "待审阅" } as const;

export function ReviewTab({ ws, proposals }: { ws: WorkspaceContext; proposals: Proposal[] }) {
  const [proposal, setProposal] = useState("");
  const { prefix, file, files, canEdit, busy, run, reload } = ws;
  return (
    <>
      <h2>逐项审阅</h2>
      <p className="muted">
        这里的建议尚未写入正文。接受后同步给所有编辑者；重叠修改会保留为待处理建议。
      </p>
      {file && !file.binary && canEdit && (
        <details>
          <summary>提交修改建议 / AI 修改结果</summary>
          <textarea
            aria-label="建议的新正文"
            value={proposal}
            onChange={(e) => setProposal(e.target.value)}
            placeholder="粘贴当前文档修改后的全文"
          />
          <button
            type="button"
            disabled={busy || !proposal || ws.status !== "saved"}
            onClick={() =>
              run(async () => {
                await api(`${prefix}/proposals`, {
                  file: file.id,
                  base: ws.editor.current?.text() || "",
                  proposed: proposal,
                });
                setProposal("");
                await reload();
              })
            }
          >
            生成逐项差异
          </button>
        </details>
      )}
      {proposals.map((p) => (
        <article className="proposal" key={p.id}>
          <h3>{files.find((f) => f.id === p.file)?.path || p.file}</h3>
          {p.hunks.map((h, i) => (
            <details className="hunk" key={h.id} open={h.status === "pending"}>
              <summary>
                {statusLabel[h.status]} · 修改 {i + 1}
              </summary>
              <pre className="before">{h.before || "（新增）"}</pre>
              <pre className="after">{h.after || "（删除）"}</pre>
              <div className="row">
                {(["accepted", "rejected", "pending"] as const).map((status) => (
                  <button
                    key={status}
                    type="button"
                    disabled={!canEdit || busy || h.status === status}
                    onClick={() =>
                      run(async () => {
                        await api(`${prefix}/proposals/${p.id}/decide`, {
                          revision: p.revision,
                          part: i,
                          status,
                        });
                        await reload();
                      })
                    }
                  >
                    {decisionLabel[status]}
                  </button>
                ))}
              </div>
            </details>
          ))}
        </article>
      ))}
    </>
  );
}
