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
      setNotice(`没有新增条目，跳过 ${result.skipped.length} 条重复文献。`);
      return;
    }
    setPreview({
      changes: [{ path: target, expected: current?.content ?? null, content: result.content }],
      label: "导入参考文献",
      summary: `新增 ${result.added} 条；跳过 ${result.skipped.length} 条重复文献；${Object.keys(result.renamed).length} 个冲突键已重命名。`,
    });
  };
  const prepareRename = () => {
    if (!rename) return;
    if (entries.some((e) => e.key === rename.next && e.key !== rename.old))
      throw new Error("目标引用键已经存在");
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
      label: "重命名引用键",
      summary: `${rename.old} → ${rename.next}，同时更新 ${changes.length} 个文件中的引用。`,
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
        throw new Error(`键 ${e.key} 对应不同文献，需先手动核对`);
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
      setNotice("没有找到 DOI 或标题/年份相同的重复条目。");
      return;
    }
    setPreview({
      changes,
      label: "合并重复文献",
      summary: `合并 ${remove.size} 个重复条目并更新引用；请核对下面的修改前后内容。`,
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
        文献库
      </button>
      {open && (
        <div className="fixed inset-0 z-[170] flex items-center justify-center bg-black/30 p-5">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="参考文献管理"
            className="flex h-[85vh] w-full max-w-6xl flex-col border border-border bg-background shadow-xl"
          >
            <header className="flex items-center justify-between border-b border-border p-3">
              <strong>参考文献 · {entries.length} 条</strong>
              <button type="button" disabled={busy} onClick={close}>
                关闭
              </button>
            </header>
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3 text-xs">
              <input
                aria-label="搜索文献"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="标题、作者、DOI 或引用键"
                className="min-w-48 flex-1 border border-border bg-background p-2"
              />
              <button type="button" disabled={busy} onClick={() => void run(reload)}>
                刷新
              </button>
              <button type="button" disabled={busy} onClick={() => void run(async () => dedupe())}>
                检查并合并重复
              </button>
              <span>
                {uses.filter((c) => !entries.some((e) => e.key === c.key)).length} 处引用缺少条目
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
                  保存到 .bib 文件
                  <input
                    aria-label="目标 BibTeX 文件"
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
                    placeholder="输入 DOI"
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
                        setNotice("已从 Crossref 获取元数据，请核对后导入。");
                      })
                    }
                  >
                    查询
                  </button>
                </div>
                <label className="block border border-border p-2">
                  导入 BibTeX 文件
                  <input
                    type="file"
                    accept=".bib,.txt"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f)
                        void run(async () => {
                          if (f.size > 2_000_000) throw new Error("文件超过 2 MB");
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
                      setNotice("已读取本机 Zotero，核对并导入后可再次同步；重复条目会跳过。");
                    })
                  }
                >
                  读取 / 同步本机 Zotero
                </button>
                <textarea
                  aria-label="待导入 BibTeX"
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder="可直接粘贴 BibTeX，也支持 Zotero 导出的 .bib"
                  className="h-44 w-full border border-border bg-background p-2 font-mono"
                />
                <button
                  type="button"
                  disabled={busy || !importText.trim() || !target.endsWith(".bib")}
                  onClick={() => void run(async () => prepareImport())}
                  className="w-full border border-foreground p-2"
                >
                  预览导入
                </button>
                <p className="text-muted">
                  导入与重命名前后创建 Git 版本。来源元数据需要核对，DOI
                  查询不会自动证明论文支持某一论述。
                </p>
              </aside>
              <div className="min-w-0 flex-1 overflow-auto p-3">
                {rename && (
                  <div className="mb-3 flex items-center gap-2 border border-border p-2 text-xs">
                    <span>{rename.old} →</span>
                    <input
                      aria-label="新引用键"
                      value={rename.next}
                      onChange={(e) => setRename({ ...rename, next: e.target.value })}
                      className="border border-border bg-background p-1"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(async () => prepareRename())}
                    >
                      预览重命名
                    </button>
                    <button type="button" onClick={() => setRename(null)}>
                      取消
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
                          {e.key} · {d.doi || "无 DOI"} · {e.file}
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
                            打开条目
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void run(async () => {
                                await navigator.clipboard.writeText(`\\cite{${e.key}}`);
                                setNotice("引用命令已复制，可在正文中粘贴。");
                              })
                            }
                          >
                            复制引用
                          </button>
                          <button
                            type="button"
                            onClick={() => setRename({ old: e.key, next: e.key })}
                          >
                            重命名键
                          </button>
                          <span>{locations.length} 处引用</span>
                        </div>
                        <details className="mt-2 text-xs">
                          <summary>引用位置</summary>
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
                          {c.expected || "（新文件）"}
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
                        setNotice("已保存文献及相关引用，并创建 Git 版本。");
                      })
                    }
                  >
                    确认保存
                  </button>
                  <button type="button" disabled={busy} onClick={() => setPreview(null)}>
                    取消
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
