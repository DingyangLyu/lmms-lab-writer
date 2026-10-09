import { diffLines } from "diff";
import { useEffect, useState } from "react";
import type { Snapshot, SnapshotChange } from "../shared/api";
import { api, errorText } from "./api";
import { type MessageKey, useI18n } from "./i18n";

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

/** Labels the server gives automatic versions, shown in the interface language. */
export function useSnapshotLabel() {
  const { t } = useI18n();
  return (label: string) => {
    const key = `snapshot.${label}` as MessageKey;
    const translated = t(key);
    return translated === key ? label : translated;
  };
}

const STATUS_CLASS: Record<Change["status"], string> = {
  added: "text-emerald-700",
  removed: "text-red-600",
  changed: "text-amber-700",
  renamed: "text-sky-700",
};
const ROW_CLASS: Record<Row["kind"], string> = {
  same: "",
  add: "bg-emerald-50 text-emerald-900",
  remove: "bg-red-50 text-red-900",
  skip: "text-muted italic",
};

/** The files a version differs in from today, and a line diff of the chosen one. */
export function SnapshotCompare({
  prefix,
  snapshot,
}: {
  prefix: string;
  snapshot: Pick<Snapshot, "id" | "label" | "created">;
}) {
  const { t } = useI18n();
  const [changes, setChanges] = useState<Change[] | null>(null),
    [selected, setSelected] = useState<Change | null>(null),
    [rows, setRows] = useState<Row[] | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    void api<Change[]>(`${prefix}/snapshots/${snapshot.id}/changes`)
      .then(setChanges)
      .catch((e) => setError(errorText(e)));
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
      .catch((e) => setError(errorText(e)));
    return () => {
      stale = true;
    };
  }, [prefix, snapshot.id, selected]);
  return (
    <div className="flex min-h-[60dvh] flex-col gap-3 md:flex-row">
      <aside className="shrink-0 overflow-auto border border-border md:w-64">
        {error && (
          <p role="alert" className="p-2 text-red-600">
            {error}
          </p>
        )}
        {changes && !changes.length && <p className="p-2 text-muted">{t("compare.none")}</p>}
        {changes?.map((c) => (
          <button
            type="button"
            key={c.id}
            aria-pressed={selected?.id === c.id}
            className={`block w-full border-b border-border px-2 py-1.5 text-left hover:bg-accent-hover ${selected?.id === c.id ? "bg-accent-hover" : ""}`}
            onClick={() => setSelected(c)}
          >
            <span className={STATUS_CLASS[c.status]}>{t(`compare.${c.status}`)}</span>{" "}
            <span className="break-all">{c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}</span>
          </button>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-auto border border-border">
        {selected?.binary && <p className="p-3 text-muted">{t("compare.binary")}</p>}
        {rows && (
          <p className="border-b border-border p-2 text-muted">
            {t("compare.legend", { path: selected?.path ?? "" })}
          </p>
        )}
        {rows && (
          <pre className="text-[11px] leading-relaxed">
            {rows.map((row, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: Rows of one immutable diff.
                key={i}
                className={`block whitespace-pre-wrap break-all px-2 ${ROW_CLASS[row.kind]}`}
              >
                {row.kind === "add" ? "+ " : row.kind === "remove" ? "- " : "  "}
                {row.kind === "skip" ? t("compare.skipped", { count: row.skipped ?? 0 }) : row.text}
              </span>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
