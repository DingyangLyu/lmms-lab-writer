import { citations, displayBib, normalizeDoi, parseBib } from "@lmms-lab/writing";
import { useEffect, useState } from "react";
import type { BibliographyImport, FileContent, SourceFile } from "../../shared/api";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";

export function BibliographyTab({
  ws,
  sources,
  refreshSources,
}: {
  ws: WorkspaceContext;
  sources: SourceFile[];
  refreshSources: () => Promise<SourceFile[]>;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState(""),
    [doi, setDoi] = useState(""),
    [bib, setBib] = useState(""),
    [bibFile, setBibFile] = useState("");
  const { prefix, canEdit, busy, run, report } = ws;
  // Opening the tab picks up edits made since the workspace loaded.
  useEffect(() => {
    void refreshSources()
      .then((s) => setBibFile((old) => old || s.find((f) => f.path.endsWith(".bib"))?.id || ""))
      .catch((e) => report(String(e)));
  }, [refreshSources, report]);
  const entries = sources
    .filter((f) => f.path.endsWith(".bib"))
    .flatMap((f) => parseBib(f.content).entries.map((e) => ({ ...e, file: f.id })));
  return (
    <>
      <h2>{t("bib.title")}</h2>
      <input
        aria-label={t("bib.search")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("bib.searchPlaceholder")}
      />
      <div className="row">
        <input
          aria-label={t("bib.doi")}
          value={doi}
          onChange={(e) => setDoi(e.target.value)}
          placeholder="DOI"
        />
        <button
          type="button"
          disabled={!canEdit || busy}
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
        </button>
      </div>
      <select
        aria-label={t("bib.target")}
        value={bibFile}
        onChange={(e) => setBibFile(e.target.value)}
      >
        <option value="">{t("bib.choose")}</option>
        {sources
          .filter((f) => f.path.endsWith(".bib"))
          .map((f) => (
            <option key={f.id} value={f.id}>
              {f.path}
            </option>
          ))}
      </select>
      <textarea
        aria-label={t("bib.import")}
        value={bib}
        onChange={(e) => setBib(e.target.value)}
        placeholder={t("bib.importPlaceholder")}
      />
      <button
        type="button"
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
      </button>
      {entries
        .filter((e) => JSON.stringify(e).toLowerCase().includes(search.toLowerCase()))
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
            <article className="bib-entry" key={`${e.file}:${e.from}`}>
              <strong>{d.title}</strong>
              <p className="muted">
                {d.authors} · {d.year}
              </p>
              <code>{e.key}</code>
              <p>{t("bib.citedTimes", { count: locations.length })}</p>
              <div className="row">
                <button
                  type="button"
                  disabled={!canEdit || !!ws.file?.binary}
                  onClick={() => ws.editor.current?.insert(`\\cite{${e.key}}`)}
                >
                  {t("bib.insert")}
                </button>
                <button
                  type="button"
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
              <details>
                <summary>{t("bib.locations")}</summary>
                {locations.map((c) => (
                  <p key={`${c.file}:${c.from}`}>
                    {c.file}:{c.line}
                  </p>
                ))}
              </details>
            </article>
          );
        })}
    </>
  );
}
