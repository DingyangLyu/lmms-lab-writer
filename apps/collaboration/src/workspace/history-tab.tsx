import { useState } from "react";
import type { Snapshot } from "../../shared/api";
import { api } from "../api";
import { SnapshotCompare } from "../history";
import type { WorkspaceContext } from "./context";

export function HistoryTab({ ws, snapshots }: { ws: WorkspaceContext; snapshots: Snapshot[] }) {
  const [label, setLabel] = useState(""),
    [comparing, setComparing] = useState<Snapshot | null>(null);
  const { prefix, file, busy, run, reload } = ws;
  if (comparing)
    return (
      <SnapshotCompare prefix={prefix} snapshot={comparing} onClose={() => setComparing(null)} />
    );
  return (
    <>
      <h2>版本与恢复</h2>
      <div className="row">
        <input
          aria-label="版本名称"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="例如：投稿前核对"
        />
        <button
          type="button"
          disabled={!ws.canEdit || busy || (!!file && !file.binary && ws.status !== "saved")}
          onClick={() =>
            run(async () => {
              await api(`${prefix}/snapshots`, { label: label || "手动版本" });
              setLabel("");
              await reload();
            })
          }
        >
          保存版本
        </button>
      </div>
      <p className="muted">
        恢复当前文件会作为一次新的共同编辑同步，恢复前再保存快照。其他文件不会被覆盖。
      </p>
      {snapshots.map((s) => (
        <article className="snapshot" key={s.id}>
          <strong>
            {s.label}
            {!s.manual && <span className="muted"> · 自动</span>}
          </strong>
          <p>{new Date(s.created).toLocaleString()}</p>
          <button type="button" onClick={() => setComparing(s)}>
            对比
          </button>{" "}
          <button
            type="button"
            disabled={busy || ws.role !== "owner" || !file || file.binary || ws.status !== "saved"}
            onClick={() => {
              if (
                !file ||
                !confirm(`把 ${file.path} 恢复到这个版本？其他人的当前编辑也会看到恢复结果。`)
              )
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
            恢复当前文件
          </button>
        </article>
      ))}
    </>
  );
}
