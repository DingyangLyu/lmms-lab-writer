"use client";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SaveManager } from "@/lib/editor/save-manager";
import { useGitSnapshots } from "@/lib/git/use-git-snapshots";

type Entry = { hash: string; timestamp: number; message: string };
export function GitVersions({
  project,
  path,
  manager,
  paused,
  onReload,
}: {
  project: string;
  path?: string;
  manager: SaveManager;
  paused: boolean;
  onReload: (path: string, content: string) => void;
}) {
  const snapshots = useGitSnapshots(project, manager, paused);
  const [history, setHistory] = useState<Entry[] | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const requestRef = useRef(0);
  const showHistory = async () => {
    setError(null);
    try {
      setHistory(await invoke<Entry[]>("git_snapshot_history", { project }));
      setSelected(null);
      setPreview("");
    } catch (cause) {
      setError(String(cause));
    }
  };
  const choose = async (entry: Entry) => {
    const request = ++requestRef.current;
    setSelected(entry);
    setPreview("正在读取版本差异…");
    setError(null);
    try {
      const diff = await invoke<string>("git_snapshot_diff", { project, hash: entry.hash });
      if (request === requestRef.current) setPreview(diff);
    } catch (cause) {
      if (request === requestRef.current) setError(String(cause));
    }
  };
  const restore = async () => {
    if (!selected || !path || paused || restoring) return;
    setError(null);
    setRestoring(true);
    try {
      const content = await invoke<string>("git_snapshot_file", {
        project,
        hash: selected.hash,
        path,
      });
      if (
        !(await ask(
          `恢复 ${path} 到 ${new Date(selected.timestamp).toLocaleString()} 的版本？会先为当前内容保存一个 Git 版本。`,
          { title: "恢复文件版本", kind: "warning" },
        ))
      )
        return;
      if (!(await snapshots.save())) return;
      manager.edit(project, path, content);
      onReload(path, content);
      await manager.flushAll();
      setHistory(null);
    } catch (cause) {
      setError(`恢复失败：${String(cause)}`);
    } finally {
      setRestoring(false);
    }
  };
  const textFile =
    !!path && /\.(tex|bib|txt|md|sty|cls|json|yaml|yml|csv|py|js|ts|html|css)$/i.test(path);
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          onClick={() => void snapshots.save()}
          disabled={snapshots.busy || paused || restoring}
          className="border border-border px-2 py-1 disabled:opacity-40"
        >
          {snapshots.busy ? "保存版本中…" : "保存 Git 版本"}
        </button>
        <button
          type="button"
          onClick={() => void showHistory()}
          className="border border-border px-2 py-1"
        >
          Git 历史
        </button>
        <label
          className="flex items-center gap-1.5 text-muted"
          title="软件打开期间自动保存；普通 Git 提交或手动保存版本后重新计时。独立本地版本，不推送远程。"
        >
          <input type="checkbox" checked={snapshots.enabled} onChange={snapshots.toggle} />
          自动 Git · 15 分钟
        </label>
        <span
          role="status"
          className="text-muted"
          title={
            snapshots.clock
              ? `下次检查 ${new Date(snapshots.clock.due).toLocaleTimeString()}`
              : snapshots.message
          }
        >
          {snapshots.enabled && paused
            ? "任务执行中，完成后保存版本"
            : snapshots.message
              ? snapshots.message
              : snapshots.enabled && snapshots.clock
                ? `下次检查 ${new Date(snapshots.clock.due).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : snapshots.message}
        </span>
      </div>
      {(snapshots.error || error) && (
        <span role="alert" className="basis-full text-red-600">
          {snapshots.error || error}
        </span>
      )}
      {history &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Git 版本历史"
            className="fixed inset-0 z-[150] flex items-center justify-center bg-black/45 p-8"
          >
            <div className="flex h-[80vh] w-full max-w-5xl flex-col border border-border bg-background shadow-xl">
              <div className="flex items-center justify-between border-b border-border p-4">
                <div>
                  <h2 className="text-base font-medium">Git 版本历史</h2>
                  <p className="mt-1 text-xs text-muted">
                    本地独立版本 · 保留最近 100 条预览 · 不影响当前分支和暂存区
                  </p>
                </div>
                <button
                  type="button"
                  disabled={restoring}
                  onClick={() => setHistory(null)}
                  className="border border-border px-3 py-1"
                >
                  关闭
                </button>
              </div>
              <div className="flex min-h-0 flex-1">
                <div className="w-52 shrink-0 overflow-y-auto border-r border-border p-2">
                  {history.length ? (
                    history.map((entry) => (
                      <button
                        type="button"
                        key={entry.hash}
                        disabled={restoring}
                        onClick={() => void choose(entry)}
                        className={`mb-1 block w-full border px-2 py-3 text-left text-xs ${selected?.hash === entry.hash ? "border-accent bg-accent/5" : "border-border"}`}
                      >
                        <span className="block">{new Date(entry.timestamp).toLocaleString()}</span>
                        <code className="mt-1 block text-muted">{entry.hash.slice(0, 7)}</code>
                      </button>
                    ))
                  ) : (
                    <p className="p-2 text-xs text-muted">
                      还没有 Git 版本。点击“保存 Git 版本”创建首个版本。
                    </p>
                  )}
                </div>
                <pre className="min-w-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed">
                  {preview || "选择一个版本，查看新增、修改和删除的内容。"}
                </pre>
              </div>
              {(error || snapshots.error) && (
                <p role="alert" className="px-4 text-xs text-red-600">
                  {error || snapshots.error}
                </p>
              )}
              <div className="flex items-center justify-between gap-3 border-t border-border p-3">
                <p className="truncate text-xs text-muted">当前文件：{path || "未打开文件"}</p>
                <button
                  type="button"
                  onClick={() => void restore()}
                  disabled={!selected || !textFile || snapshots.busy || restoring || paused}
                  className="shrink-0 border border-foreground px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  {restoring ? "正在恢复…" : "恢复当前文件"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
