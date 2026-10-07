import { diffLines } from "diff";
import { useEffect, useState } from "react";
import { api } from "./api";

type Change = {
  id: string;
  path: string;
  oldPath?: string;
  binary: boolean;
  status: "added" | "removed" | "changed" | "renamed";
};
const statusName: Record<Change["status"], string> = {
  added: "新增",
  removed: "已删除",
  changed: "有修改",
  renamed: "改名",
};
type Row = { kind: "same" | "add" | "remove" | "skip"; text: string };

/** Unified diff with long unchanged stretches folded to three lines of context. */
export function diffRows(before: string, after: string): Row[] {
  const rows: Row[] = [];
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    const kind: Row["kind"] = part.added ? "add" : part.removed ? "remove" : "same";
    if (kind === "same" && lines.length > 7) {
      rows.push(...lines.slice(0, 3).map((text) => ({ kind, text })));
      rows.push({ kind: "skip", text: `… ${lines.length - 6} 行未改动 …` });
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
  snapshot: { id: string; label: string; created: number };
  onClose: () => void;
}) {
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
          ← 版本列表
        </button>
        <strong>
          “{snapshot.label}”（{new Date(snapshot.created).toLocaleString()}）→ 现在
        </strong>
      </div>
      {error && <p className="error">{error}</p>}
      {changes && !changes.length && <p className="muted">这个版本之后没有文件变化。</p>}
      {changes?.map((c) => (
        <button
          type="button"
          key={c.id}
          className={`compare-file ${selected?.id === c.id ? "active" : ""}`}
          onClick={() => setSelected(c)}
        >
          <span className={`compare-status ${c.status}`}>{statusName[c.status]}</span>{" "}
          {c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}
        </button>
      ))}
      {selected?.binary && <p className="muted">二进制文件不能逐行对比。</p>}
      {rows && <p className="muted">{selected?.path} 的修改（- 版本中，+ 现在）</p>}
      {rows && (
        <pre className="diff">
          {rows.map((row, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: Rows of one immutable diff.
              key={i}
              className={`diff-${row.kind}`}
            >
              {row.kind === "add" ? "+ " : row.kind === "remove" ? "- " : "  "}
              {row.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
