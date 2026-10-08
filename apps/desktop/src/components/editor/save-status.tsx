"use client";

import type { DocumentConflict } from "@lmms-lab/writing";
import { invoke } from "@tauri-apps/api/core";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useState } from "react";
import type { DocumentSave, SaveManager } from "@/lib/editor/save-manager";
import { useAnnotations } from "@/lib/pdf/annotation-context";
import { AnnotationManager } from "./annotation-manager";
import { BibliographyPanel } from "./bibliography-panel";
import { ConflictCenter } from "./conflict-center";
import { GitVersions } from "./git-versions";
import { ReviewCenter } from "./review-center";

export function SaveStatus({
  agentBusy = false,
  rightActions,
  collaboration,
  onConflictResolved,
  manager,
  project,
  path,
  onReload,
  onOpenDraft,
  onOpenFile,
  highlightAmbiguousUnicode,
  onToggleUnicodeHighlight,
  closeError,
  clearCloseError,
}: {
  agentBusy?: boolean;
  rightActions?: ReactNode;
  /** The collaboration sync button for the open project. */
  collaboration?: ReactNode;
  onConflictResolved?: (conflict: DocumentConflict) => void;
  manager: SaveManager;
  project?: string | null;
  path?: string;
  onReload: (path: string, content: string) => void;
  onOpenDraft: (path: string, content: string) => void;
  onOpenFile: (path: string) => void;
  highlightAmbiguousUnicode: boolean;
  onToggleUnicodeHighlight: () => void;
  closeError: string | null;
  clearCloseError: () => void;
}) {
  const annotations = useAnnotations();
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<{
    path: string;
    project: string;
    items: { id: string; timestamp: number; bytes: number }[];
  } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const docs = [...manager.documents.values()];
  const problems = docs.filter((doc) => doc.error || doc.draftError || doc.recovered);
  const saving = docs.some((doc) => doc.saving);
  const pending = docs.some((doc) => doc.dirty);
  const perform = async (operation: () => Promise<void>) => {
    try {
      await operation();
      setMessage(null);
      clearCloseError();
    } catch (error) {
      setMessage(String(error));
    }
  };
  const exportCopy = async (doc: DocumentSave) => {
    const destination = await save({
      title: "另存恢复副本（请选择新文件名）",
      defaultPath: `${doc.project}/${doc.path}.recovered-${Date.now()}.txt`,
    });
    if (destination) {
      await invoke("export_document_copy", { path: destination, content: doc.content });
      setMessage(`恢复副本已保存到 ${destination}。原草稿仍保留。`);
    }
  };
  return (
    <div className="border-b border-border bg-background text-xs" aria-live="polite">
      <div className="flex flex-wrap items-center gap-3 px-3 py-1.5">
        <span role="status">
          {problems.some((doc) => doc.error)
            ? "保存失败 · 请处理下方提示"
            : saving
              ? "正在保存…"
              : pending
                ? "有未保存修改"
                : "全部已保存"}
        </span>
        <button
          type="button"
          className="border border-border px-2 py-1"
          onClick={() => void perform(() => manager.flushAll())}
        >
          保存全部 ⌘S / Ctrl+S
        </button>
        <button
          type="button"
          disabled={!project || !path}
          className="border border-border px-2 py-1 disabled:opacity-40"
          onClick={() =>
            void perform(async () => {
              if (!project || !path) return;
              const items = await invoke<{ id: string; timestamp: number; bytes: number }[]>(
                "list_document_backups",
                { project, path },
              );
              setPreview(null);
              setHistory({ project, path, items });
            })
          }
        >
          历史备份
        </button>
        <button
          type="button"
          aria-pressed={highlightAmbiguousUnicode}
          title="切换易混淆全角标点的方框提示"
          className="border border-border px-2 py-1 shrink-0 hover:border-foreground"
          onClick={onToggleUnicodeHighlight}
        >
          字符方框：{highlightAmbiguousUnicode ? "开" : "关"}
        </button>
        {project && <AnnotationManager />}
        {project && collaboration}
        {project && (
          <BibliographyPanel
            key={`bib:${project}`}
            project={project}
            manager={manager}
            onOpen={onOpenFile}
          />
        )}
        {project && (
          <ReviewCenter
            key={`review:${project}`}
            project={project}
            manager={manager}
            agentBusy={agentBusy}
            onOpen={onOpenFile}
          />
        )}
        {project && (
          <ConflictCenter
            key={`conflicts:${project}`}
            project={project}
            manager={manager}
            onResolved={onConflictResolved}
          />
        )}
        {project && (
          <GitVersions
            key={project}
            project={project}
            path={path}
            manager={manager}
            paused={agentBusy || Boolean(annotations?.busy)}
            onReload={onReload}
          />
        )}
        <div className="ml-auto">{rightActions}</div>
      </div>
      {(message || closeError) && (
        <p role="alert" className="px-3 pb-2 text-accent whitespace-pre-wrap">
          {message || closeError}
        </p>
      )}
      {problems.map((doc) => (
        <div key={`${doc.project}/${doc.path}`} className="border-t border-border px-3 py-2">
          <p className="break-all">
            {doc.path}：
            {doc.error || doc.draftError || "发现并恢复了未保存草稿。请检查内容，再点击保存。"}
          </p>
          {doc.error && doc.draftError && <p>{doc.draftError}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => onOpenDraft(doc.path, doc.content)}>
              打开草稿
            </button>
            <button type="button" onClick={() => void perform(() => manager.flushDocument(doc))}>
              重试保存
            </button>
            <button
              type="button"
              onClick={() => {
                void exportCopy(doc).catch((error) => setMessage(String(error)));
              }}
            >
              另存副本
            </button>
            <button
              type="button"
              disabled={doc.saving}
              onClick={() =>
                void perform(async () => {
                  if (
                    !(await ask(
                      "放弃这个文件的未保存草稿，重新读取磁盘文件？如需保留草稿，请先另存副本。",
                      { title: "重新读取磁盘版本", kind: "warning" },
                    ))
                  )
                    return;
                  const content = await invoke<string>("read_document", {
                    project: doc.project,
                    path: doc.path,
                  });
                  manager.discard(doc.project, doc.path, content);
                  if (doc.project === project) onReload(doc.path, content);
                })
              }
            >
              重新读取磁盘版本
            </button>
          </div>
        </div>
      ))}
      {history && (
        <div className="fixed inset-0 z-50 bg-foreground/50 flex items-center justify-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="历史备份"
            className="bg-background border border-border p-5 w-[700px] max-w-[95vw] max-h-[85vh] overflow-auto"
          >
            <div className="flex justify-between gap-3">
              <strong>历史备份：{history.path}</strong>
              <button type="button" onClick={() => setHistory(null)}>
                关闭
              </button>
            </div>
            <p className="my-3">
              每次覆盖保存前保留原文，每个文件保留最近 30 份。选择版本可预览，确认恢复后会自动保存。
            </p>
            {history.items.length === 0 && <p>暂无历史版本。首次修改并保存后会出现备份。</p>}
            <div className="max-h-40 overflow-auto">
              {history.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="block w-full text-left border-b border-border py-2"
                  onClick={() =>
                    void perform(async () => {
                      setPreview(
                        await invoke<string>("read_document_backup", {
                          project: history.project,
                          path: history.path,
                          id: item.id,
                        }),
                      );
                    })
                  }
                >
                  {new Date(item.timestamp).toLocaleString()} · {item.bytes} bytes
                </button>
              ))}
            </div>
            {preview !== null && (
              <>
                <pre className="whitespace-pre-wrap break-words my-3 max-h-64 overflow-auto border border-border p-3">
                  {preview}
                </pre>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    void perform(async () => {
                      if (
                        !(await ask(
                          "将此历史版本恢复到编辑器？当前未保存的修改会被替换，请先保存或另存副本。",
                          { title: "恢复历史版本", kind: "warning" },
                        ))
                      )
                        return;
                      manager.edit(history.project, history.path, preview);
                      onReload(history.path, preview);
                      setHistory(null);
                    })
                  }
                >
                  恢复此版本
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
