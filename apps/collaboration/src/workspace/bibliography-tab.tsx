import { citations, displayBib, normalizeDoi, parseBib } from "@lmms-lab/writing";
import { useEffect, useState } from "react";
import type { BibliographyImport, FileContent, SourceFile } from "../../shared/api";
import { api } from "../api";
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
      <h2>项目文献库</h2>
      <input
        aria-label="搜索文献"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="标题、作者、引用键"
      />
      <div className="row">
        <input
          aria-label="查询 DOI"
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
          查询
        </button>
      </div>
      <select aria-label="目标文献库" value={bibFile} onChange={(e) => setBibFile(e.target.value)}>
        <option value="">选择 .bib 文件</option>
        {sources
          .filter((f) => f.path.endsWith(".bib"))
          .map((f) => (
            <option key={f.id} value={f.id}>
              {f.path}
            </option>
          ))}
      </select>
      <textarea
        aria-label="导入 BibTeX"
        value={bib}
        onChange={(e) => setBib(e.target.value)}
        placeholder="粘贴 BibTeX（也可由 Zotero 导出）"
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
              .join("，");
            ws.notify(
              `导入 ${result.added} 条，跳过 ${result.skipped.length} 条重复文献${
                renamed ? `；引用键冲突已改名：${renamed}` : ""
              }`,
            );
            setBib("");
            await refreshSources();
          })
        }
      >
        导入并去重
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
              <p>{locations.length} 处引用</p>
              <div className="row">
                <button
                  type="button"
                  disabled={!canEdit || !!ws.file?.binary}
                  onClick={() => ws.editor.current?.insert(`\\cite{${e.key}}`)}
                >
                  插入引用
                </button>
                <button
                  type="button"
                  disabled={!canEdit || busy}
                  onClick={() => {
                    const to = prompt("新引用键", e.key);
                    if (to && to !== e.key)
                      run(async () => {
                        await api(`${prefix}/bibliography/rename`, { from: e.key, to });
                        await refreshSources();
                      });
                  }}
                >
                  重命名键
                </button>
              </div>
              <details>
                <summary>引用位置</summary>
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
