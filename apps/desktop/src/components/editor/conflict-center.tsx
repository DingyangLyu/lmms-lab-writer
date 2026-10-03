"use client";
import type { DocumentConflict, SaveResult } from "@lmms-lab/writing";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveManager } from "@/lib/editor/save-manager";
import { sameProject } from "@/lib/project-root";
export function ConflictCenter({
  project,
  manager,
  onResolved,
}: {
  project: string;
  manager: SaveManager;
  onResolved?: (conflict: DocumentConflict) => void;
}) {
  const [pending, setPending] = useState<DocumentConflict[]>([]),
    [open, setOpen] = useState(false),
    [selected, setSelected] = useState<DocumentConflict | null>(null),
    [choices, setChoices] = useState<Record<number, string>>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [resume, setResume] = useState(true);
  const originalEditor = useRef<string | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      setPending(await invoke<DocumentConflict[]>("list_document_conflicts", { project }));
    } catch (e) {
      setError(String(e));
    }
  }, [project]);
  useEffect(() => {
    void refresh();
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{ project: string }>("writer://conflicts-changed", ({ payload }) => {
      if (sameProject(payload.project, project)) void refresh();
    }).then((s) => {
      if (disposed) s();
      else stop = s;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [project, refresh]);
  const local = [...manager.documents.values()]
    .filter((d) => d.project === project && d.localConflict)
    .map((d) => d.localConflict as DocumentConflict);
  const all = [...local, ...pending];
  const choose = (conflict: DocumentConflict) => {
    setSelected(conflict);
    setChoices({});
    setError("");
    originalEditor.current = manager.get(project, conflict.path)?.content;
  };
  const complete = selected?.parts.every((p, i) => p.text !== null || choices[i] !== undefined);
  const apply = async () => {
    if (!selected || !complete) return;
    setBusy(true);
    setError("");
    try {
      const content = selected.parts.map((p, i) => p.text ?? choices[i] ?? "").join("");
      const doc = manager.get(project, selected.path);
      if (doc && doc.content !== originalEditor.current)
        throw new Error("编辑器草稿又有更新，双方内容仍保留；请重新选择此冲突以核对最新版本。");
      if (selected.local) {
        if (!doc) throw new Error("草稿未载入");
        await manager.resolveLocal(doc, content, originalEditor.current ?? "");
        await invoke("git_create_snapshot", { project, message: "Writer · 解决编辑器合并冲突" });
      } else {
        if (doc?.running) await doc.running;
        if (selected.owner !== "editor" && doc?.dirty) await manager.synchronizeDocument(doc);
        if (doc && doc.content !== originalEditor.current)
          throw new Error("文稿在准备合并时又有更新，请重新选择最新冲突。");
        const editorBefore = doc?.content;
        const result = await invoke<SaveResult>("resolve_document_conflict", {
          project,
          id: selected.id,
          expectedRevision: selected.revision,
          content,
        });
        if (result.status === "conflict") {
          if (result.conflict) choose(result.conflict);
          throw new Error("核对期间文件又有重叠修改，已更新冲突，尚未覆盖文稿。");
        }
        await manager.acceptResolved(project, selected.path, result.content, editorBefore);
        if (result.versionError) {
          setSelected(null);
          throw new Error(`${result.versionError}；请使用保存 Git 版本按钮重试。`);
        }
      }
      if (resume) onResolved?.(selected);
      setSelected(null);
      await refresh();
    } catch (e) {
      setError(String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className={`border px-2 py-1 ${all.length ? "border-orange-500 text-accent" : "border-border"}`}
        onClick={() => {
          setOpen((v) => !v);
          void refresh();
        }}
        title="查看并合并双方的文稿修改"
      >
        冲突 {all.length}
      </button>
      {open && (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/30 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="文稿合并冲突"
            className="flex max-h-[90vh] w-full max-w-5xl flex-col border border-border bg-background shadow-xl"
          >
            <header className="flex items-center justify-between border-b border-border p-3">
              <strong>文稿合并 · 双方内容均已保留</strong>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setSelected(null);
                }}
                aria-label="关闭冲突面板"
              >
                ×
              </button>
            </header>
            <div className="flex min-h-0 flex-1">
              <aside className="w-56 shrink-0 overflow-y-auto border-r border-border p-2">
                {all.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className={`mb-2 w-full border p-2 text-left ${selected?.id === c.id ? "border-accent" : "border-border"}`}
                    onClick={() => choose(c)}
                  >
                    <span className="block truncate">{c.path}</span>
                    <small>
                      {c.owner === "editor" ? "编辑器与磁盘" : "Agent 修改提案"} ·{" "}
                      {c.parts.filter((p) => p.text === null).length} 处
                    </small>
                  </button>
                ))}
                {!all.length && <p className="p-2 text-muted">没有待处理冲突。</p>}
              </aside>
              <div className="min-w-0 flex-1 overflow-auto p-3">
                {!selected ? (
                  <p className="text-muted">选择一个文件查看差异。无冲突的修改会自动合并。</p>
                ) : (
                  <>
                    <p className="mb-3 text-muted">
                      {selected.path} · 仅选择有重叠的部分，其他修改自动保留。
                    </p>
                    {selected.parts.map((part, i) =>
                      part.text !== null ? (
                        <pre
                          // biome-ignore lint/suspicious/noArrayIndexKey: Immutable ordered hunks for this conflict revision.
                          key={`${selected.id}-${selected.revision}-context-${i}`}
                          className="my-2 max-h-20 overflow-auto whitespace-pre-wrap text-[11px] text-muted"
                        >
                          {part.text}
                        </pre>
                      ) : (
                        <section
                          // biome-ignore lint/suspicious/noArrayIndexKey: Immutable ordered hunks for this conflict revision.
                          key={`${selected.id}-${selected.revision}-conflict-${i}`}
                          className="my-3 border border-orange-400 p-3"
                        >
                          <details className="mb-2">
                            <summary>共同基准</summary>
                            <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs">
                              {part.base}
                            </pre>
                          </details>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <strong>
                                {selected.owner === "editor" ? "你的草稿" : "当前文件"}
                              </strong>
                              <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap border border-border p-2 text-xs">
                                {part.ours || "（删除）"}
                              </pre>
                              <button
                                type="button"
                                className="border border-border px-2 py-1"
                                onClick={() => setChoices((c) => ({ ...c, [i]: part.ours || "" }))}
                              >
                                保留这一侧
                              </button>
                            </div>
                            <div>
                              <strong>
                                {selected.local
                                  ? "另一处编辑"
                                  : selected.owner === "editor"
                                    ? "磁盘修改（AI／外部）"
                                    : "Agent 建议"}
                              </strong>
                              <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap border border-border p-2 text-xs">
                                {part.theirs || "（删除）"}
                              </pre>
                              <button
                                type="button"
                                className="border border-border px-2 py-1"
                                onClick={() =>
                                  setChoices((c) => ({ ...c, [i]: part.theirs || "" }))
                                }
                              >
                                采用这一侧
                              </button>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="my-2 border border-border px-2 py-1"
                            onClick={() =>
                              setChoices((c) => ({
                                ...c,
                                [i]: (part.ours || "") + (part.theirs || ""),
                              }))
                            }
                          >
                            保留双方并编辑
                          </button>
                          <label className="block">
                            最终文本
                            <textarea
                              aria-label={`冲突 ${i + 1} 最终文本`}
                              className="mt-1 min-h-24 w-full border border-border bg-background p-2 font-mono text-xs"
                              placeholder="先选择一侧，或在这里手动合并…"
                              value={choices[i] ?? ""}
                              onChange={(e) => setChoices((c) => ({ ...c, [i]: e.target.value }))}
                            />
                          </label>
                        </section>
                      ),
                    )}
                  </>
                )}
              </div>
            </div>
            {error && (
              <p role="alert" className="border-t border-border p-3 text-accent">
                {error}
              </p>
            )}
            <footer className="flex items-center justify-between border-t border-border p-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={resume}
                  onChange={(e) => setResume(e.target.checked)}
                />
                合并后通知已打开的原 Agent 对话继续核验
              </label>
              <button
                type="button"
                disabled={busy || !complete}
                onClick={() => void apply()}
                className="border border-foreground bg-foreground px-3 py-2 text-background disabled:opacity-40"
              >
                {busy ? "合并与保存中…" : "保存合并结果并记录 Git"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
