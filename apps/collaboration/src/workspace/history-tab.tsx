import { useState } from "react";
import type { Snapshot } from "../../shared/api";
import { api } from "../api";
import { SnapshotCompare } from "../history";
import { type MessageKey, useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";

/** Labels the server gives automatic versions, shown in the interface language. */
export function useSnapshotLabel() {
  const { t } = useI18n();
  return (label: string) => {
    const key = `snapshot.${label}` as MessageKey;
    const translated = t(key);
    return translated === key ? label : translated;
  };
}

export function HistoryTab({ ws, snapshots }: { ws: WorkspaceContext; snapshots: Snapshot[] }) {
  const { t, locale } = useI18n();
  const snapshotLabel = useSnapshotLabel();
  const [label, setLabel] = useState(""),
    [comparing, setComparing] = useState<Snapshot | null>(null);
  const { prefix, file, busy, run, reload } = ws;
  if (comparing)
    return (
      <SnapshotCompare prefix={prefix} snapshot={comparing} onClose={() => setComparing(null)} />
    );
  return (
    <>
      <h2>{t("history.title")}</h2>
      <div className="row">
        <input
          aria-label={t("history.name")}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("history.placeholder")}
        />
        <button
          type="button"
          disabled={!ws.canEdit || busy || (!!file && !file.binary && ws.status !== "saved")}
          onClick={() =>
            run(async () => {
              await api(`${prefix}/snapshots`, { label: label || t("history.manual") });
              setLabel("");
              await reload();
            })
          }
        >
          {t("history.save")}
        </button>
      </div>
      <p className="muted">{t("history.lead")}</p>
      {snapshots.map((s) => (
        <article className="snapshot" key={s.id}>
          <strong>
            {snapshotLabel(s.label)}
            {!s.manual && <span className="muted">{t("history.automatic")}</span>}
          </strong>
          <p>{new Date(s.created).toLocaleString(locale === "zh" ? "zh-CN" : "en")}</p>
          <button type="button" onClick={() => setComparing(s)}>
            {t("history.compare")}
          </button>{" "}
          <button
            type="button"
            disabled={busy || ws.role !== "owner" || !file || file.binary || ws.status !== "saved"}
            onClick={() => {
              if (!file || !confirm(t("history.restoreConfirm", { path: file.path }))) return;
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
        </article>
      ))}
    </>
  );
}
