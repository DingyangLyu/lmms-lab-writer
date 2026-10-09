/** Suggested changes (from co-authors or AI tasks) to accept or reject one by one. */
import { useState } from "react";
import type { Proposal } from "../../shared/api";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { Btn, Dialog, TextArea } from "./ui";

export function ReviewDialog({
  ws,
  proposals,
  onClose,
}: {
  ws: WorkspaceContext;
  proposals: Proposal[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [proposal, setProposal] = useState("");
  const { prefix, file, files, canEdit, busy, run, reload } = ws;
  return (
    <Dialog wide title={t("review.title")} onClose={onClose}>
      <p className="mb-3 text-muted">{t("review.lead")}</p>
      {file && !file.binary && canEdit && (
        <details className="mb-3 border border-border p-2">
          <summary className="cursor-pointer">{t("review.submit")}</summary>
          <TextArea
            aria-label={t("review.proposed")}
            rows={8}
            value={proposal}
            onChange={(e) => setProposal(e.target.value)}
            placeholder={t("review.paste")}
            className="mt-2 font-mono"
          />
          <Btn
            className="mt-2"
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
          </Btn>
        </details>
      )}
      {!proposals.length && <p className="py-6 text-center text-muted">{t("shell.noProposals")}</p>}
      {proposals.map((p) => (
        <article key={p.id} className="mb-3 border border-border">
          <h3 className="border-b border-border px-3 py-2 font-medium">
            {files.find((f) => f.id === p.file)?.path || p.file}
          </h3>
          {p.hunks.map((h, i) => (
            <details
              key={h.id}
              open={h.status === "pending"}
              className="border-b border-border last:border-b-0"
            >
              <summary className="cursor-pointer px-3 py-2">
                {t(`review.status.${h.status}`)} · {t("review.change", { n: i + 1 })}
              </summary>
              <div className="grid gap-px bg-border md:grid-cols-2">
                <pre className="whitespace-pre-wrap break-all bg-red-50 p-2 text-[11px] text-red-900">
                  {h.before || t("review.added")}
                </pre>
                <pre className="whitespace-pre-wrap break-all bg-emerald-50 p-2 text-[11px] text-emerald-900">
                  {h.after || t("review.removed")}
                </pre>
              </div>
              <div className="flex flex-wrap gap-2 p-2">
                {(["accepted", "rejected", "pending"] as const).map((status) => (
                  <Btn
                    key={status}
                    tone={status === "accepted" ? "solid" : "plain"}
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
                  </Btn>
                ))}
              </div>
            </details>
          ))}
        </article>
      ))}
    </Dialog>
  );
}
