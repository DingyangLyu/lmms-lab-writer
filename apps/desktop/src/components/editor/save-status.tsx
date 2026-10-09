"use client";

import type { DocumentConflict } from "@lmms-lab/writing";
import { invoke } from "@tauri-apps/api/core";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useState } from "react";
import { TeamComments } from "@/components/collab/team-comments";
import type { DocumentSave, SaveManager } from "@/lib/editor/save-manager";
import { useI18n } from "@/lib/i18n";
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
  const { t } = useI18n();
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
      title: t("save.saveARecoveryCopyChooseANewFileName"),
      defaultPath: `${doc.project}/${doc.path}.recovered-${Date.now()}.txt`,
    });
    if (destination) {
      await invoke("export_document_copy", { path: destination, content: doc.content });
      setMessage(t("save.recoveryCopySavedToDestinationTheDraftIs", { destination }));
    }
  };
  return (
    <div className="border-b border-border bg-background text-xs" aria-live="polite">
      <div className="flex flex-wrap items-center gap-3 px-3 py-1.5">
        <span role="status">
          {problems.some((doc) => doc.error)
            ? t("save.saveFailedSeeBelow")
            : saving
              ? t("save.saving")
              : pending
                ? t("save.unsavedChanges")
                : t("save.allSaved")}
        </span>
        <button
          type="button"
          className="border border-border px-2 py-1"
          onClick={() => void perform(() => manager.flushAll())}
        >
          {t("save.saveAllSCtrlS")}
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
          {t("save.backups")}
        </button>
        <button
          type="button"
          aria-pressed={highlightAmbiguousUnicode}
          title={t("save.toggleBoxesAroundEasilyConfusedFullWidth")}
          className="border border-border px-2 py-1 shrink-0 hover:border-foreground"
          onClick={onToggleUnicodeHighlight}
        >
          {t("save.characterBoxesState", {
            state: highlightAmbiguousUnicode ? t("save.on") : t("save.off"),
          })}
        </button>
        {project && <AnnotationManager />}
        {project && <TeamComments onOpenFile={onOpenFile} />}
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
            {doc.error || doc.draftError || t("save.anUnsavedDraftWasFoundAndRestoredCheckIt")}
          </p>
          {doc.error && doc.draftError && <p>{doc.draftError}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => onOpenDraft(doc.path, doc.content)}>
              {t("save.openDraft")}
            </button>
            <button type="button" onClick={() => void perform(() => manager.flushDocument(doc))}>
              {t("save.retrySaving")}
            </button>
            <button
              type="button"
              onClick={() => {
                void exportCopy(doc).catch((error) => setMessage(String(error)));
              }}
            >
              {t("save.saveACopy")}
            </button>
            <button
              type="button"
              disabled={doc.saving}
              onClick={() =>
                void perform(async () => {
                  if (
                    !(await ask(t("save.discardThisFileSUnsavedDraftAndReloadItF"), {
                      title: t("save.reloadFromDisk"),
                      kind: "warning",
                    }))
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
              {t("save.reloadFromDisk")}
            </button>
          </div>
        </div>
      ))}
      {history && (
        <div className="fixed inset-0 z-50 bg-foreground/50 flex items-center justify-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("save.backups")}
            className="bg-background border border-border p-5 w-[700px] max-w-[95vw] max-h-[85vh] overflow-auto"
          >
            <div className="flex justify-between gap-3">
              <strong>{t("save.backupsPath", { path: history.path })}</strong>
              <button type="button" onClick={() => setHistory(null)}>
                {t("save.close")}
              </button>
            </div>
            <p className="my-3">{t("save.eachSaveKeepsThePreviousTextTheLatest30A")}</p>
            {history.items.length === 0 && (
              <p>{t("save.noBackupsYetTheyAppearAfterTheFirstSaved")}</p>
            )}
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
                        !(await ask(t("save.restoreThisBackupIntoTheEditorUnsavedCha"), {
                          title: t("save.restoreBackup"),
                          kind: "warning",
                        }))
                      )
                        return;
                      manager.edit(history.project, history.path, preview);
                      onReload(history.path, preview);
                      setHistory(null);
                    })
                  }
                >
                  {t("save.restoreThisVersion")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
