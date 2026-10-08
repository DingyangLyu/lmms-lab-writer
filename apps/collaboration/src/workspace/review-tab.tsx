import { useState } from "react";
import type { Proposal } from "../../shared/api";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";

export function ReviewTab({ ws, proposals }: { ws: WorkspaceContext; proposals: Proposal[] }) {
  const { t } = useI18n();
  const [proposal, setProposal] = useState("");
  const { prefix, file, files, canEdit, busy, run, reload } = ws;
  return (
    <>
      <h2>{t("review.title")}</h2>
      <p className="muted">{t("review.lead")}</p>
      {file && !file.binary && canEdit && (
        <details>
          <summary>{t("review.submit")}</summary>
          <textarea
            aria-label={t("review.proposed")}
            value={proposal}
            onChange={(e) => setProposal(e.target.value)}
            placeholder={t("review.paste")}
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
            {t("review.diff")}
          </button>
        </details>
      )}
      {proposals.map((p) => (
        <article className="proposal" key={p.id}>
          <h3>{files.find((f) => f.id === p.file)?.path || p.file}</h3>
          {p.hunks.map((h, i) => (
            <details className="hunk" key={h.id} open={h.status === "pending"}>
              <summary>
                {t(`review.status.${h.status}`)} · {t("review.change", { n: i + 1 })}
              </summary>
              <pre className="before">{h.before || t("review.added")}</pre>
              <pre className="after">{h.after || t("review.removed")}</pre>
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
                    {t(`review.decide.${status}`)}
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
