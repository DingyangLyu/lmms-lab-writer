"use client";
import {
  bibliographyIdentity,
  citations,
  displayBib,
  importBibliography,
  normalizeDoi,
  parseBib,
  renameBibKey,
  renameCitationKey,
} from "@lmms-lab/writing";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import type { SaveManager } from "@/lib/editor/save-manager";
import { useI18n } from "@/lib/i18n";

type Source = { path: string; content: string; revision: string };
type Edit = { path: string; expected: string | null; content: string };
export function BibliographyPanel({
  project,
  manager,
  onOpen,
}: {
  project: string;
  manager: SaveManager;
  onOpen: (path: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [files, setFiles] = useState<Source[]>([]),
    [query, setQuery] = useState("");
  const [target, setTarget] = useState(""),
    [doi, setDoi] = useState(""),
    [importText, setImportText] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [rename, setRename] = useState<{ old: string; next: string } | null>(null);
  const [preview, setPreview] = useState<{
    changes: Edit[];
    label: string;
    summary: string;
  } | null>(null);
  const sources = useMemo(() => files.filter((f) => f.path.endsWith(".bib")), [files]);
  const entries = useMemo(
    () =>
      sources.flatMap((file) =>
        parseBib(file.content).entries.map((entry) => ({ ...entry, file: file.path })),
      ),
    [sources],
  );
  const uses = useMemo(
    () =>
      files
        .filter((f) => f.path.endsWith(".tex"))
        .flatMap((f) => citations(f.content).map((c) => ({ ...c, file: f.path }))),
    [files],
  );
  const close = () => {
    setOpen(false);
    setFiles([]);
    setPreview(null);
    setRename(null);
  };
  const reload = async () => {
    await manager.synchronize(project);
    const sources = await invoke<Source[]>("writing_list_sources", { project });
    setFiles(sources);
    setTarget(
      (old) => old || sources.find((f) => f.path.endsWith(".bib"))?.path || "references.bib",
    );
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const prepareImport = () => {
    const current = files.find((f) => f.path === target);
    const result = importBibliography(current?.content || "", importText);
    if (!result.added) {
      setNotice(
        t("bib.nothingNewSkippedSkippedSkippedDuplicate", { skipped: result.skipped.length }),
      );
      return;
    }
    setPreview({
      changes: [{ path: target, expected: current?.content ?? null, content: result.content }],
      label: t("bib.importReferences"),
      summary: t("bib.addedAddedSkippedSkippedSkippedDuplicate", {
        added: result.added,
        skipped: result.skipped.length,
        renamed: Object.keys(result.renamed).length,
      }),
    });
  };
  const prepareRename = () => {
    if (!rename) return;
    if (entries.some((e) => e.key === rename.next && e.key !== rename.old))
      throw new Error(t("bib.thatCitationKeyAlreadyExists"));
    const changes = files.flatMap((f) => {
      const content = f.path.endsWith(".bib")
        ? renameBibKey(f.content, rename.old, rename.next)
        : f.path.endsWith(".tex")
          ? renameCitationKey(f.content, rename.old, rename.next)
          : f.content;
      return content === f.content ? [] : [{ path: f.path, expected: f.content, content }];
    });
    if (!changes.length) return;
    setPreview({
      changes,
      label: t("bib.renameCitationKey"),
      summary: t("bib.oldNextUpdatingCitationsInCountCountFile", {
        old: rename.old,
        next: rename.next,
        count: changes.length,
      }),
    });
  };
  const dedupe = () => {
    const canonical = new Map<string, (typeof entries)[number]>(),
      remove = new Set<string>();
    const replacements = new Map<string, string>();
    for (const e of entries) {
      const id = bibliographyIdentity(e),
        first = canonical.get(id);
      if (!first) {
        canonical.set(id, e);
        continue;
      }
      if (entries.some((other) => other.key === e.key && bibliographyIdentity(other) !== id))
        throw new Error(t("bib.keyKeyBelongsToDifferentReferencesCheckT", { key: e.key }));
      remove.add(`${e.file}:${e.from}`);
      if (e.key !== first.key) replacements.set(e.key, first.key);
    }
    const changes = files.flatMap((f) => {
      let content = f.content;
      if (f.path.endsWith(".bib"))
        for (const e of entries
          .filter((e) => e.file === f.path && remove.has(`${e.file}:${e.from}`))
          .reverse())
          content = content.slice(0, e.from) + content.slice(e.to);
      if (f.path.endsWith(".tex"))
        for (const cite of citations(content).reverse()) {
          const key = replacements.get(cite.key);
          if (key) content = content.slice(0, cite.from) + key + content.slice(cite.to);
        }
      return content === f.content ? [] : [{ path: f.path, expected: f.content, content }];
    });
    if (!changes.length) {
      setNotice(t("bib.noDuplicatesWithTheSameDoiOrTitleAndYear"));
      return;
    }
    setPreview({
      changes,
      label: t("bib.mergeDuplicateReferences"),
      summary: t("bib.mergeCountCountDuplicateDuplicatesAndUpd", { count: remove.size }),
    });
  };
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          void run(reload);
        }}
        className="border border-border px-2 py-1 text-xs"
      >
        {t("bib.references")}
      </button>
      {open && (
        <div className="fixed inset-0 z-[170] flex items-center justify-center bg-black/30 p-5">
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t("bib.referenceManager")}
            className="flex h-[85vh] w-full max-w-6xl flex-col border border-border bg-background shadow-xl"
          >
            <header className="flex items-center justify-between border-b border-border p-3">
              <strong>{t("bib.referencesCount", { count: entries.length })}</strong>
              <button type="button" disabled={busy} onClick={close}>
                {t("bib.close")}
              </button>
            </header>
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3 text-xs">
              <input
                aria-label={t("bib.searchReferences")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("bib.titleAuthorDoiOrCitationKey")}
                className="min-w-48 flex-1 border border-border bg-background p-2"
              />
              <button type="button" disabled={busy} onClick={() => void run(reload)}>
                {t("bib.refresh")}
              </button>
              <button type="button" disabled={busy} onClick={() => void run(async () => dedupe())}>
                {t("bib.findAndMergeDuplicates")}
              </button>
              <span>
                {t("bib.countCountCitationHasCitationsHaveNoEntr", {
                  count: uses.filter((c) => !entries.some((e) => e.key === c.key)).length,
                })}
              </span>
            </div>
            {error && (
              <p role="alert" className="whitespace-pre-wrap p-3 text-sm text-red-600">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="p-3 text-sm">
                {notice}
              </p>
            )}
            <div className="flex min-h-0 flex-1">
              <aside className="w-72 shrink-0 space-y-3 overflow-auto border-r border-border p-3 text-xs">
                <label className="block">
                  {t("bib.saveToBibFile")}
                  <input
                    aria-label={t("bib.targetBibtexFile")}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="mt-1 w-full border border-border bg-background p-2"
                  />
                </label>
                <div className="flex gap-1">
                  <input
                    aria-label="DOI"
                    value={doi}
                    onChange={(e) => setDoi(e.target.value)}
                    placeholder={t("bib.enterADoi")}
                    className="min-w-0 flex-1 border border-border bg-background p-2"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setImportText(
                          await invoke<string>("bibliography_lookup_doi", {
                            doi: normalizeDoi(doi),
                          }),
                        );
                        setNotice(t("bib.metadataFetchedFromCrossrefCheckItThenIm"));
                      })
                    }
                  >
                    {t("bib.lookUp")}
                  </button>
                </div>
                <label className="block border border-border p-2">
                  {t("bib.importBibtexFile")}
                  <input
                    type="file"
                    accept=".bib,.txt"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f)
                        void run(async () => {
                          if (f.size > 2_000_000) throw new Error(t("bib.theFileExceeds2Mb"));
                          setImportText(await f.text());
                        });
                      e.target.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  className="w-full border border-border p-2"
                  onClick={() =>
                    void run(async () => {
                      setImportText(await invoke<string>("bibliography_zotero_local"));
                      setNotice(t("bib.readTheLocalZoteroLibraryCheckAndImportY"));
                    })
                  }
                >
                  {t("bib.readSyncLocalZotero")}
                </button>
                <textarea
                  aria-label={t("bib.bibtexToImport")}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder={t("bib.pasteBibtexHereBibExportedFromZoteroWork")}
                  className="h-44 w-full border border-border bg-background p-2 font-mono"
                />
                <button
                  type="button"
                  disabled={busy || !importText.trim() || !target.endsWith(".bib")}
                  onClick={() => void run(async () => prepareImport())}
                  className="w-full border border-foreground p-2"
                >
                  {t("bib.previewImport")}
                </button>
                <p className="text-muted">{t("bib.gitVersionsAreCreatedBeforeAndAfterImpor")}</p>
              </aside>
              <div className="min-w-0 flex-1 overflow-auto p-3">
                {rename && (
                  <div className="mb-3 flex items-center gap-2 border border-border p-2 text-xs">
                    <span>{rename.old} →</span>
                    <input
                      aria-label={t("bib.newCitationKey")}
                      value={rename.next}
                      onChange={(e) => setRename({ ...rename, next: e.target.value })}
                      className="border border-border bg-background p-1"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(async () => prepareRename())}
                    >
                      {t("bib.previewRename")}
                    </button>
                    <button type="button" onClick={() => setRename(null)}>
                      {t("bib.cancel")}
                    </button>
                  </div>
                )}
                {entries
                  .filter((e) =>
                    JSON.stringify(e.fields)
                      .concat(e.key)
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((e) => {
                    const d = displayBib(e),
                      locations = uses.filter((c) => c.key === e.key);
                    return (
                      <article
                        key={`${e.file}:${e.from}`}
                        className="mb-3 border border-border p-3 text-sm"
                      >
                        <strong>{d.title}</strong>
                        <p className="my-1 text-xs text-muted">
                          {d.authors} · {d.year}
                        </p>
                        <p className="break-all text-xs">
                          {e.key} · {d.doi || t("bib.noDoi")} · {e.file}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-3 text-xs">
                          <button
                            type="button"
                            onClick={() => {
                              onOpen(
                                `${e.file}#L${
                                  files
                                    .find((f) => f.path === e.file)
                                    ?.content.slice(0, e.from)
                                    .split("\n").length || 1
                                }`,
                              );
                              close();
                            }}
                          >
                            {t("bib.openEntry")}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void run(async () => {
                                await navigator.clipboard.writeText(`\\cite{${e.key}}`);
                                setNotice(t("bib.citationCommandCopiedPasteItIntoTheText"));
                              })
                            }
                          >
                            {t("bib.copyCitation")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setRename({ old: e.key, next: e.key })}
                          >
                            {t("bib.renameKey")}
                          </button>
                          <span>
                            {t("bib.citedCountCountTimeTimes", { count: locations.length })}
                          </span>
                        </div>
                        <details className="mt-2 text-xs">
                          <summary>{t("bib.citedAt")}</summary>
                          {locations.map((c) => (
                            <button
                              key={`${c.file}:${c.from}`}
                              type="button"
                              className="mr-3 mt-2 underline"
                              onClick={() => {
                                onOpen(`${c.file}#L${c.line}`);
                                close();
                              }}
                            >
                              {c.file}:{c.line}
                            </button>
                          ))}
                        </details>
                      </article>
                    );
                  })}
              </div>
            </div>
            {preview && (
              <div className="absolute inset-8 z-10 flex flex-col border border-border bg-background p-4 shadow-xl">
                <strong>{preview.summary}</strong>
                <div className="my-3 min-h-0 flex-1 overflow-auto">
                  {preview.changes.map((c) => (
                    <details key={c.path} open>
                      <summary>{c.path}</summary>
                      <div className="grid grid-cols-2 gap-2">
                        <pre className="overflow-auto whitespace-pre-wrap border border-border p-2 text-xs">
                          {c.expected || t("bib.newFile")}
                        </pre>
                        <pre className="overflow-auto whitespace-pre-wrap border border-border p-2 text-xs">
                          {c.content}
                        </pre>
                      </div>
                    </details>
                  ))}
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await manager.flushAll(project);
                        await invoke("writing_apply_changes", {
                          project,
                          changes: preview.changes,
                          label: preview.label,
                        });
                        setPreview(null);
                        setRename(null);
                        setImportText("");
                        await reload();
                        setNotice(t("bib.referencesAndCitationsSavedWithAGitVersi"));
                      })
                    }
                  >
                    {t("bib.save")}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setPreview(null)}>
                    {t("bib.cancel")}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
