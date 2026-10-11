"use client";
/**
 * The server project's versions for a linked folder, beside the local Git versions: the same
 * list the web's History shows (saved by hand, before AI turns, every half hour while edited),
 * what changed in the open file since one of them, and restoring the open file from it. A
 * restore is an ordinary edit here, which the folder sync takes to the server.
 */
import { lines, reviewHunks } from "@lmms-lab/writing";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type SyncLink, serverRequest } from "@/lib/collab/accounts";
import type { SaveManager } from "@/lib/editor/save-manager";
import { useI18n } from "@/lib/i18n";

type Version = { id: string; label: string; author: string; created: number; manual: boolean };
type ServerFile = { id: string; path: string; binary: boolean };
/** The open file as it was then, and as it is here now. */
type Comparison = { version: Version; before: string | null; now: string };

export function ServerVersions({
  link,
  project,
  path,
  manager,
  paused,
  flush,
  onReload,
}: {
  link: SyncLink;
  project: string;
  path?: string;
  manager: SaveManager;
  paused: boolean;
  /** Saves editors and uploads, so a new version holds what is on screen. */
  flush: () => Promise<void>;
  onReload: (path: string, content: string) => void;
}) {
  const { t } = useI18n();
  const api = `/api/projects/${link.project}`;
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const list = () =>
    run(async () => {
      setVersions(await serverRequest<Version[]>(link.server, "GET", `${api}/snapshots`));
      setComparison(null);
    });
  const save = () =>
    run(async () => {
      await manager.flushAll();
      await flush();
      await serverRequest(link.server, "POST", `${api}/snapshots`, {});
      if (versions)
        setVersions(await serverRequest<Version[]>(link.server, "GET", `${api}/snapshots`));
    });
  const choose = (version: Version) =>
    run(async () => {
      const mine = ++request.current;
      if (!path) return setComparison({ version, before: null, now: "" });
      await manager.flushAll();
      const files = await serverRequest<ServerFile[]>(link.server, "GET", `${api}/files`);
      const file = files.find((f) => f.path === path && !f.binary);
      const before = file
        ? await serverRequest<{ content: string }>(
            link.server,
            "GET",
            `${api}/snapshots/${version.id}/files/${file.id}`,
          ).then(
            (r) => r.content,
            () => null,
          )
        : null;
      const now = await invoke<string>("read_document", { project, path });
      if (mine === request.current) setComparison({ version, before, now });
    });
  const restore = () =>
    run(async () => {
      if (!comparison || comparison.before === null || !path || paused) return;
      if (
        !(await ask(
          t("collab.versions.restoreConfirm", {
            path,
            time: new Date(comparison.version.created).toLocaleString(),
          }),
          { title: t("collab.versions.restore"), kind: "warning" },
        ))
      )
        return;
      manager.edit(project, path, comparison.before);
      onReload(path, comparison.before);
      await manager.flushAll();
      setVersions(null);
    });
  const hunks = comparison?.before == null ? [] : reviewHunks(comparison.before, comparison.now);
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || paused}
          className="border border-border px-2 py-1 disabled:opacity-40"
          title={t("collab.versions.saveTitle")}
        >
          {t("collab.versions.save")}
        </button>
        <button
          type="button"
          onClick={() => void list()}
          className="border border-border px-2 py-1"
        >
          {t("collab.versions.history")}
        </button>
      </div>
      {error && !versions && (
        <span role="alert" className="basis-full text-red-600">
          {error}
        </span>
      )}
      {versions &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("collab.versions.title")}
            className="fixed inset-0 z-[150] flex items-center justify-center bg-black/45 p-8"
          >
            <div className="flex h-[80vh] w-full max-w-5xl flex-col border border-border bg-background shadow-xl">
              <div className="flex items-center justify-between border-b border-border p-4">
                <div>
                  <h2 className="text-base font-medium">{t("collab.versions.title")}</h2>
                  <p className="mt-1 text-xs text-muted">
                    {t("collab.versions.hint", { project: link.name })}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setVersions(null)}
                  className="border border-border px-3 py-1"
                >
                  {t("gitv.close")}
                </button>
              </div>
              <div className="flex min-h-0 flex-1">
                <div className="w-56 shrink-0 overflow-y-auto border-r border-border p-2">
                  {versions.length ? (
                    versions.map((version) => (
                      <button
                        type="button"
                        key={version.id}
                        disabled={busy}
                        onClick={() => void choose(version)}
                        className={`mb-1 block w-full border px-2 py-2 text-left text-xs ${comparison?.version.id === version.id ? "border-accent bg-accent/5" : "border-border"}`}
                      >
                        <span className="block">{new Date(version.created).toLocaleString()}</span>
                        <span className="mt-1 block truncate text-muted">{version.label}</span>
                      </button>
                    ))
                  ) : (
                    <p className="p-2 text-xs text-muted">{t("collab.versions.none")}</p>
                  )}
                </div>
                <div className="min-w-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
                  {!comparison ? (
                    <p className="font-sans text-muted">{t("collab.versions.choose")}</p>
                  ) : comparison.before === null ? (
                    <p className="font-sans text-muted">
                      {path ? t("collab.versions.notInVersion", { path }) : t("gitv.noFileOpen")}
                    </p>
                  ) : !hunks.length ? (
                    <p className="font-sans text-muted">
                      {t("collab.versions.same", { path: path ?? "" })}
                    </p>
                  ) : (
                    hunks.map((hunk) => (
                      <div key={hunk.id} className="mb-3 border-l-2 border-border pl-2">
                        {hunk.before && (
                          <div className="whitespace-pre-wrap bg-red-500/10 text-red-700">
                            {lines(hunk.before)
                              .map((line) => `- ${line}`)
                              .join("")}
                          </div>
                        )}
                        {hunk.after && (
                          <div className="whitespace-pre-wrap bg-green-500/10 text-green-700">
                            {lines(hunk.after)
                              .map((line) => `+ ${line}`)
                              .join("")}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
              {error && (
                <p role="alert" className="px-4 text-xs text-red-600">
                  {error}
                </p>
              )}
              <div className="flex items-center justify-between gap-3 border-t border-border p-3">
                <p className="truncate text-xs text-muted">
                  {t("collab.versions.legend", { path: path || t("gitv.noFileOpen") })}
                </p>
                <button
                  type="button"
                  onClick={() => void restore()}
                  disabled={
                    !comparison || comparison.before === null || !hunks.length || busy || paused
                  }
                  className="shrink-0 border border-foreground px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  {t("collab.versions.restore")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
