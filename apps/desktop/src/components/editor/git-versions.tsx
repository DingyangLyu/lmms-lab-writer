"use client";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SaveManager } from "@/lib/editor/save-manager";
import { useGitSnapshots } from "@/lib/git/use-git-snapshots";
import { useI18n } from "@/lib/i18n";

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
  const { t } = useI18n();
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
    setPreview(t("gitv.readingTheVersionSChanges"));
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
          t("gitv.restorePathToTheVersionFromTimeTheCurren", {
            path,
            time: new Date(selected.timestamp).toLocaleString(),
          }),
          { title: t("gitv.restoreFileVersion"), kind: "warning" },
        ))
      )
        return;
      if (!(await snapshots.save())) return;
      manager.edit(project, path, content);
      onReload(path, content);
      await manager.flushAll();
      setHistory(null);
    } catch (cause) {
      setError(t("gitv.restoreFailedError", { error: String(cause) }));
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
          {snapshots.busy ? t("gitv.savingVersion") : t("gitv.saveGitVersion")}
        </button>
        <button
          type="button"
          onClick={() => void showHistory()}
          className="border border-border px-2 py-1"
        >
          {t("gitv.gitHistory")}
        </button>
        <label
          className="flex items-center gap-1.5 text-muted"
          title={t("gitv.savedAutomaticallyWhileTheAppIsOpenANorm")}
        >
          <input type="checkbox" checked={snapshots.enabled} onChange={snapshots.toggle} />
          {t("gitv.autoGit15Min")}
        </label>
        <span
          role="status"
          className="text-muted"
          title={
            snapshots.clock
              ? t("gitv.nextCheckTime", {
                  time: new Date(snapshots.clock.due).toLocaleTimeString(),
                })
              : snapshots.message
          }
        >
          {snapshots.enabled && paused
            ? t("gitv.taskRunningTheVersionIsSavedWhenItEnds")
            : snapshots.message
              ? snapshots.message
              : snapshots.enabled && snapshots.clock
                ? t("gitv.nextCheckTime", {
                    time: new Date(snapshots.clock.due).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  })
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
            aria-label={t("gitv.gitVersions")}
            className="fixed inset-0 z-[150] flex items-center justify-center bg-black/45 p-8"
          >
            <div className="flex h-[80vh] w-full max-w-5xl flex-col border border-border bg-background shadow-xl">
              <div className="flex items-center justify-between border-b border-border p-4">
                <div>
                  <h2 className="text-base font-medium">{t("gitv.gitVersions")}</h2>
                  <p className="mt-1 text-xs text-muted">
                    {t("gitv.localVersionsLast100KeptYourBranchAndSta")}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={restoring}
                  onClick={() => setHistory(null)}
                  className="border border-border px-3 py-1"
                >
                  {t("gitv.close")}
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
                      {t("gitv.noGitVersionsYetClickSaveGitVersionToCre")}
                    </p>
                  )}
                </div>
                <pre className="min-w-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed">
                  {preview || t("gitv.selectAVersionToSeeWhatWasAddedChangedAn")}
                </pre>
              </div>
              {(error || snapshots.error) && (
                <p role="alert" className="px-4 text-xs text-red-600">
                  {error || snapshots.error}
                </p>
              )}
              <div className="flex items-center justify-between gap-3 border-t border-border p-3">
                <p className="truncate text-xs text-muted">
                  {t("gitv.currentFilePath", { path: path || t("gitv.noFileOpen") })}
                </p>
                <button
                  type="button"
                  onClick={() => void restore()}
                  disabled={!selected || !textFile || snapshots.busy || restoring || paused}
                  className="shrink-0 border border-foreground px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  {restoring ? t("gitv.restoring") : t("gitv.restoreCurrentFile")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
