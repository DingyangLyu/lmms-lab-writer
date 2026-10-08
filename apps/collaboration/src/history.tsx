import { diffLines } from "diff";
import { useEffect, useState } from "react";
import type { Snapshot, SnapshotChange } from "../shared/api";
import { api } from "./api";
import { useI18n } from "./i18n";
import { useSnapshotLabel } from "./workspace/history-tab";

type Change = SnapshotChange;
/** `skipped` counts the unchanged lines a folded row stands for. */
type Row = { kind: "same" | "add" | "remove" | "skip"; text: string; skipped?: number };

/** Unified diff with long unchanged stretches folded to three lines of context. */
export function diffRows(before: string, after: string): Row[] {
  const rows: Row[] = [];
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    const kind: Row["kind"] = part.added ? "add" : part.removed ? "remove" : "same";
    if (kind === "same" && lines.length > 7) {
      rows.push(...lines.slice(0, 3).map((text) => ({ kind, text })));
      rows.push({ kind: "skip", text: "", skipped: lines.length - 6 });
      rows.push(...lines.slice(-3).map((text) => ({ kind, text })));
    } else rows.push(...lines.map((text) => ({ kind, text })));
  }
  return rows;
}

export function SnapshotCompare({
  prefix,
  snapshot,
  onClose,
}: {
  prefix: string;
  snapshot: Pick<Snapshot, "id" | "label" | "created">;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const snapshotLabel = useSnapshotLabel();
  const [changes, setChanges] = useState<Change[] | null>(null),
    [selected, setSelected] = useState<Change | null>(null),
    [rows, setRows] = useState<Row[] | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    void api<Change[]>(`${prefix}/snapshots/${snapshot.id}/changes`)
      .then(setChanges)
      .catch((e) => setError(String(e)));
  }, [prefix, snapshot.id]);
  useEffect(() => {
    setRows(null);
    if (!selected || selected.binary) return;
    let stale = false;
    void Promise.all([
      selected.status === "added"
        ? Promise.resolve("")
        : api<{ content: string }>(`${prefix}/snapshots/${snapshot.id}/files/${selected.id}`).then(
            (r) => r.content,
          ),
      selected.status === "removed"
        ? Promise.resolve("")
        : api<{ content: string }>(`${prefix}/files/${selected.id}`).then((r) => r.content),
    ])
      .then(([before, after]) => {
        if (!stale) setRows(diffRows(before, after));
      })
      .catch((e) => setError(String(e)));
    return () => {
      stale = true;
    };
  }, [prefix, snapshot.id, selected]);
  return (
    <div className="compare">
      <div className="row">
        <button type="button" onClick={onClose}>
          {t("compare.back")}
        </button>
        <strong>
          {t("compare.heading", {
            label: snapshotLabel(snapshot.label),
            time: new Date(snapshot.created).toLocaleString(locale === "zh" ? "zh-CN" : "en"),
          })}
        </strong>
      </div>
      {error && <p className="error">{error}</p>}
      {changes && !changes.length && <p className="muted">{t("compare.none")}</p>}
      {changes?.map((c) => (
        <button
          type="button"
          key={c.id}
          className={`compare-file ${selected?.id === c.id ? "active" : ""}`}
          onClick={() => setSelected(c)}
        >
          <span className={`compare-status ${c.status}`}>{t(`compare.${c.status}`)}</span>{" "}
          {c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}
        </button>
      ))}
      {selected?.binary && <p className="muted">{t("compare.binary")}</p>}
      {rows && <p className="muted">{t("compare.legend", { path: selected?.path ?? "" })}</p>}
      {rows && (
        <pre className="diff">
          {rows.map((row, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: Rows of one immutable diff.
              key={i}
              className={`diff-${row.kind}`}
            >
              {row.kind === "add" ? "+ " : row.kind === "remove" ? "- " : "  "}
              {row.kind === "skip" ? t("compare.skipped", { count: row.skipped ?? 0 }) : row.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
