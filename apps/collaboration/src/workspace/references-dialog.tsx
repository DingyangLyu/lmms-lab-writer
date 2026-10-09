/** The project's BibTeX library, opened from the status bar like the desktop's References. */
import { citations, displayBib, normalizeDoi, parseBib } from "@lmms-lab/writing";
import { useEffect, useState } from "react";
import type { BibliographyImport, FileContent, SourceFile } from "../../shared/api";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { Btn, Dialog, Input, Select, TextArea } from "./ui";

export function ReferencesDialog({
  ws,
  sources,
  refreshSources,
  onClose,
}: {
  ws: WorkspaceContext;
  sources: SourceFile[];
  refreshSources: () => Promise<SourceFile[]>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState(""),
    [doi, setDoi] = useState(""),
    [bib, setBib] = useState(""),
    [bibFile, setBibFile] = useState("");
  const { prefix, canEdit, busy, run, report } = ws;
  // Opening picks up edits made since the workspace loaded.
  useEffect(() => {
    void refreshSources()
      .then((s) => setBibFile((old) => old || s.find((f) => f.path.endsWith(".bib"))?.id || ""))
      .catch((e) => report(errorText(e)));
  }, [refreshSources, report]);
  const bibs = sources.filter((f) => f.path.endsWith(".bib"));
  const entries = bibs.flatMap((f) =>
    parseBib(f.content).entries.map((e) => ({ ...e, file: f.id })),
  );
  const needle = search.toLowerCase();
  return (
    <Dialog wide title={t("bib.title")} onClose={onClose}>
      <div className="flex min-h-[60dvh] flex-col gap-3 md:flex-row">
        <aside className="shrink-0 space-y-2 md:w-72">
          <div className="flex gap-2">
            <Input
              aria-label={t("bib.doi")}
              value={doi}
              onChange={(e) => setDoi(e.target.value)}
              placeholder="DOI"
              className="min-w-0 flex-1"
            />
            <Btn
              disabled={!canEdit || busy || !doi.trim()}
              onClick={() =>
                run(async () => {
                  const result = await api<{ bibtex: string }>(`${prefix}/doi`, {
                    doi: normalizeDoi(doi),
                  });
                  setBib(result.bibtex);
                })
              }
            >
              {t("bib.lookup")}
            </Btn>
          </div>
          <Select
            aria-label={t("bib.target")}
            value={bibFile}
            onChange={(e) => setBibFile(e.target.value)}
            className="w-full"
          >
            <option value="">{t("bib.choose")}</option>
            {bibs.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </Select>
          <TextArea
            aria-label={t("bib.import")}
            rows={8}
            value={bib}
            onChange={(e) => setBib(e.target.value)}
            placeholder={t("bib.importPlaceholder")}
            className="font-mono"
          />
          <Btn
            tone="solid"
            disabled={!canEdit || busy || !bibFile || !bib.trim()}
            onClick={() =>
              run(async () => {
                const current = await api<FileContent>(`${prefix}/files/${bibFile}`);
                const result = await api<BibliographyImport>(`${prefix}/bibliography/import`, {
                  file: bibFile,
                  expected: "content" in current ? current.content : "",
                  bibtex: bib,
                });
                const renamed = Object.entries(result.renamed ?? {})
                  .map(([from, to]) => `${from}→${to}`)
                  .join(t("bib.listSeparator"));
                ws.notify(
                  t("bib.imported", { added: result.added, skipped: result.skipped.length }) +
                    (renamed ? t("bib.renamedKeys", { list: renamed }) : ""),
                );
                setBib("");
                await refreshSources();
              })
            }
          >
            {t("bib.importButton")}
          </Btn>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col gap-2">
          <Input
            aria-label={t("bib.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("bib.searchPlaceholder")}
          />
          <div className="min-h-0 flex-1 overflow-auto">
            {entries
              .filter((e) => !needle || JSON.stringify(e).toLowerCase().includes(needle))
              .map((e) => {
                const d = displayBib(e),
                  locations = sources
                    .filter((f) => f.path.endsWith(".tex"))
                    .flatMap((f) =>
                      citations(f.content)
                        .filter((c) => c.key === e.key)
                        .map((c) => ({ ...c, file: f.path })),
                    );
                return (
                  <article key={`${e.file}:${e.from}`} className="mb-3 border border-border p-3">
                    <strong className="text-sm">{d.title}</strong>
                    <p className="my-1 text-muted">
                      {d.authors} · {d.year}
                    </p>
                    <p className="break-all">
                      <code>{e.key}</code> · {t("bib.citedTimes", { count: locations.length })}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-3">
                      <button
                        type="button"
                        className="hover:text-accent disabled:text-muted"
                        disabled={!canEdit || !!ws.file?.binary}
                        onClick={() => ws.editor.current?.insert(`\\cite{${e.key}}`)}
                      >
                        {t("bib.insert")}
                      </button>
                      <button
                        type="button"
                        className="hover:text-accent disabled:text-muted"
                        disabled={!canEdit || busy}
                        onClick={() => {
                          const to = prompt(t("bib.renamePrompt"), e.key);
                          if (to && to !== e.key)
                            run(async () => {
                              await api(`${prefix}/bibliography/rename`, { from: e.key, to });
                              await refreshSources();
                            });
                        }}
                      >
                        {t("bib.rename")}
                      </button>
                    </div>
                    {!!locations.length && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-muted">
                          {t("bib.locations")}
                        </summary>
                        {locations.map((c) => (
                          <p key={`${c.file}:${c.from}`} className="text-muted">
                            {c.file}:{c.line}
                          </p>
                        ))}
                      </details>
                    )}
                  </article>
                );
              })}
          </div>
        </section>
      </div>
    </Dialog>
  );
}
