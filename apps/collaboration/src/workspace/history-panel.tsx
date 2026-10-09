/** Saved versions in the sidebar, where the desktop shows Git: save, compare, restore. */
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { Snapshot } from "../../shared/api";
import { api } from "../api";
import { SnapshotCompare, useSnapshotLabel } from "../history";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { Btn, Dialog, Input } from "./ui";

export function HistoryPanel({ ws, snapshots }: { ws: WorkspaceContext; snapshots: Snapshot[] }) {
  const { t, locale } = useI18n();
  const snapshotLabel = useSnapshotLabel();
  const [label, setLabel] = useState(""),
    [comparing, setComparing] = useState<Snapshot | null>(null);
  const { prefix, file, busy, run, reload } = ws;
  const time = (ms: number) => new Date(ms).toLocaleString(locale === "zh" ? "zh-CN" : "en");
  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <form
        className="flex shrink-0 gap-2 border-b border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api(`${prefix}/snapshots`, { label: label || t("history.manual") });
            setLabel("");
            await reload();
          });
        }}
      >
        <Input
          aria-label={t("history.name")}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("history.placeholder")}
          className="min-w-0 flex-1"
        />
        <Btn
          type="submit"
          disabled={!ws.canEdit || busy || (!!file && !file.binary && ws.status !== "saved")}
        >
          {t("history.save")}
        </Btn>
      </form>
      <p className="shrink-0 border-b border-border px-3 py-2 text-[11px] text-muted">
        {t("history.lead")}
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        {snapshots.map((s) => (
          <article key={s.id} className="border-b border-border px-3 py-2">
            <div className="flex items-start gap-2">
              <ClockCounterClockwiseIcon className="mt-0.5 size-3.5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <strong className="block truncate font-medium">
                  {snapshotLabel(s.label)}
                  {!s.manual && (
                    <span className="font-normal text-muted">{t("history.automatic")}</span>
                  )}
                </strong>
                <span className="text-muted">{time(s.created)}</span>
                <div className="mt-1 flex flex-wrap gap-3">
                  <button
                    type="button"
                    className="hover:text-accent"
                    onClick={() => setComparing(s)}
                  >
                    {t("history.compare")}
                  </button>
                  <button
                    type="button"
                    className="hover:text-accent disabled:text-muted"
                    disabled={
                      busy || ws.role !== "owner" || !file || file.binary || ws.status !== "saved"
                    }
                    onClick={() => {
                      if (!file || !confirm(t("history.restoreConfirm", { path: file.path })))
                        return;
                      run(async () => {
                        await api(`${prefix}/snapshots/${s.id}/restore`, {
                          file: file.id,
                          expected: ws.editor.current?.text() || "",
                        });
                        await reload();
                      });
                    }}
                  >
                    {t("history.restore")}
                  </button>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
      {comparing && (
        <Dialog
          wide
          title={t("compare.heading", {
            label: snapshotLabel(comparing.label),
            time: time(comparing.created),
          })}
          onClose={() => setComparing(null)}
        >
          <SnapshotCompare prefix={prefix} snapshot={comparing} />
        </Dialog>
      )}
    </div>
  );
}
