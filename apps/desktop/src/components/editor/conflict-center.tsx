"use client";
import type { DocumentConflict, SaveResult } from "@lmms-lab/writing";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveManager } from "@/lib/editor/save-manager";
import { useI18n } from "@/lib/i18n";
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
  const { t } = useI18n();
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
        throw new Error(t("conflict.theEditorDraftChangedAgainBothVersionsAr"));
      if (selected.local) {
        if (!doc) throw new Error(t("conflict.theDraftIsNotLoaded"));
        await manager.resolveLocal(doc, content, originalEditor.current ?? "");
        await invoke("git_create_snapshot", {
          project,
          message: t("conflict.writerResolveEditorMergeConflict"),
        });
      } else {
        if (doc?.running) await doc.running;
        if (selected.owner !== "editor" && doc?.dirty) await manager.synchronizeDocument(doc);
        if (doc && doc.content !== originalEditor.current)
          throw new Error(t("conflict.theDocumentChangedWhilePreparingTheMerge"));
        const editorBefore = doc?.content;
        const result = await invoke<SaveResult>("resolve_document_conflict", {
          project,
          id: selected.id,
          expectedRevision: selected.revision,
          content,
        });
        if (result.status === "conflict") {
          if (result.conflict) choose(result.conflict);
          throw new Error(t("conflict.theFileGotAnotherOverlappingChangeWhileY"));
        }
        await manager.acceptResolved(project, selected.path, result.content, editorBefore);
        if (result.versionError) {
          setSelected(null);
          throw new Error(
            t("conflict.errorUseTheSaveGitVersionButtonToRetry", { error: result.versionError }),
          );
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
        title={t("conflict.reviewAndMergeBothSidesChanges")}
      >
        {t("conflict.conflictsCount", { count: all.length })}
      </button>
      {open && (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/30 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t("conflict.mergeConflicts")}
            className="flex max-h-[90vh] w-full max-w-5xl flex-col border border-border bg-background shadow-xl"
          >
            <header className="flex items-center justify-between border-b border-border p-3">
              <strong>{t("conflict.mergeBothVersionsAreKept")}</strong>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setSelected(null);
                }}
                aria-label={t("conflict.closeTheConflictPanel")}
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
                      {c.owner === "editor"
                        ? t("conflict.editorAndDisk")
                        : t("conflict.agentProposal")}{" "}
                      ·{" "}
                      {t("conflict.countCountSpotSpots", {
                        count: c.parts.filter((p) => p.text === null).length,
                      })}
                    </small>
                  </button>
                ))}
                {!all.length && (
                  <p className="p-2 text-muted">{t("conflict.noConflictsToResolve")}</p>
                )}
              </aside>
              <div className="min-w-0 flex-1 overflow-auto p-3">
                {!selected ? (
                  <p className="text-muted">
                    {t("conflict.selectAFileToSeeTheDifferencesNonOverlap")}
                  </p>
                ) : (
                  <>
                    <p className="mb-3 text-muted">
                      {t("conflict.pathChooseOnlyWhereChangesOverlapEveryth", {
                        path: selected.path,
                      })}
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
                            <summary>{t("conflict.commonBase")}</summary>
                            <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs">
                              {part.base}
                            </pre>
                          </details>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <strong>
                                {selected.owner === "editor"
                                  ? t("conflict.yourDraft")
                                  : t("conflict.currentFile")}
                              </strong>
                              <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap border border-border p-2 text-xs">
                                {part.ours || t("conflict.deleted")}
                              </pre>
                              <button
                                type="button"
                                className="border border-border px-2 py-1"
                                onClick={() => setChoices((c) => ({ ...c, [i]: part.ours || "" }))}
                              >
                                {t("conflict.keepThisSide")}
                              </button>
                            </div>
                            <div>
                              <strong>
                                {selected.local
                                  ? t("conflict.otherEdit")
                                  : selected.owner === "editor"
                                    ? t("conflict.diskChangeAiExternal")
                                    : t("conflict.agentSuggestion")}
                              </strong>
                              <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap border border-border p-2 text-xs">
                                {part.theirs || t("conflict.deleted")}
                              </pre>
                              <button
                                type="button"
                                className="border border-border px-2 py-1"
                                onClick={() =>
                                  setChoices((c) => ({ ...c, [i]: part.theirs || "" }))
                                }
                              >
                                {t("conflict.useThisSide")}
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
                            {t("conflict.keepBothAndEdit")}
                          </button>
                          <label className="block">
                            {t("conflict.finalText")}
                            <textarea
                              aria-label={t("conflict.finalTextOfConflictN", { n: i + 1 })}
                              className="mt-1 min-h-24 w-full border border-border bg-background p-2 font-mono text-xs"
                              placeholder={t("conflict.pickASideFirstOrMergeByHandHere")}
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
                {t("conflict.afterMergingTellTheOriginalAgentConversa")}
              </label>
              <button
                type="button"
                disabled={busy || !complete}
                onClick={() => void apply()}
                className="border border-foreground bg-foreground px-3 py-2 text-background disabled:opacity-40"
              >
                {busy ? t("conflict.mergingAndSaving") : t("conflict.saveTheMergeAndRecordItInGit")}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
