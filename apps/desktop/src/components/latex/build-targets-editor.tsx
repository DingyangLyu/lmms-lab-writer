"use client";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { readCompilerOverrides, writeCompilerOverrides } from "@/lib/latex/compiler-overrides";
import type { BuildTarget, LaTeXCompilersStatus, ProjectBuildConfig } from "@/lib/latex/types";
import { makeBuildTarget } from "@/lib/latex/use-latex-settings";
export function BuildTargetsEditor({
  project,
  config,
  texFiles,
  onSave,
}: {
  project: string;
  config: ProjectBuildConfig;
  texFiles: string[];
  onSave: (next: ProjectBuildConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState(config);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newEntry, setNewEntry] = useState("");
  const [catalog, setCatalog] = useState<LaTeXCompilersStatus | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft(config);
  }, [config]);
  useEffect(() => {
    setOverrides(readCompilerOverrides());
  }, []);
  const update = (id: string, value: Partial<BuildTarget>) =>
    setDraft((current) => ({
      ...current,
      targets: current.targets.map((t) => (t.id === id ? { ...t, ...value } : t)),
    }));
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 py-2 text-xs">
      <p className="text-sm font-medium">编译目标 · 中英文／不同模板可分别配置</p>
      <p className="text-muted">
        主文件、工作目录和输出目录都相对项目根目录，保存在
        .writer/latex.json，随项目迁移。每个目标应使用不同 PDF 输出位置。
      </p>
      {draft.targets.map((target) => (
        <div key={target.id} className="space-y-2 border border-border p-3">
          <div className="flex gap-2">
            <label className="min-w-0 flex-1">
              名称
              <input
                aria-label={`目标名称 ${target.name}`}
                value={target.name}
                onChange={(e) => update(target.id, { name: e.target.value })}
                className="mt-1 w-full border border-border bg-background p-1.5"
              />
            </label>
            <label className="w-36">
              引擎
              <select
                value={target.engine}
                onChange={(e) =>
                  update(target.id, { engine: e.target.value as BuildTarget["engine"] })
                }
                className="mt-1 w-full border border-border bg-background p-1.5"
              >
                <option value="auto">自动检测</option>
                <option value="xelatex">XeLaTeX</option>
                <option value="pdflatex">pdfLaTeX</option>
                <option value="lualatex">LuaLaTeX</option>
                <option value="latexmk">latexmk · 自动引擎</option>
                <option value="tectonic">Tectonic</option>
              </select>
            </label>
          </div>
          <label className="block">
            主文件
            <input
              value={target.mainFile}
              list="latex-entry-files"
              onChange={(e) => update(target.id, { mainFile: e.target.value })}
              className="mt-1 w-full border border-border bg-background p-1.5 font-mono"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label>
              工作目录
              <input
                value={target.workDir}
                onChange={(e) => update(target.id, { workDir: e.target.value })}
                className="mt-1 w-full border border-border bg-background p-1.5 font-mono"
              />
            </label>
            <label>
              输出目录
              <input
                value={target.outputDir}
                onChange={(e) => update(target.id, { outputDir: e.target.value })}
                className="mt-1 w-full border border-border bg-background p-1.5 font-mono"
              />
            </label>
          </div>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="active-build-target"
                checked={draft.activeTarget === target.id}
                onChange={() => setDraft((current) => ({ ...current, activeTarget: target.id }))}
              />
              当前编译目标
            </label>
            <button
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  targets: current.targets.filter((t) => t.id !== target.id),
                  activeTarget:
                    current.activeTarget === target.id
                      ? (current.targets.find((t) => t.id !== target.id)?.id ?? null)
                      : current.activeTarget,
                }))
              }
            >
              移除目标
            </button>
          </div>
        </div>
      ))}
      <datalist id="latex-entry-files">
        {texFiles.map((file) => (
          <option key={file} value={file} />
        ))}
      </datalist>
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="新增主文件路径"
          placeholder="例如 main_en.tex 或 en/main.tex"
          list="latex-entry-files"
          value={newEntry}
          onChange={(e) => setNewEntry(e.target.value)}
          className="min-w-0 flex-1 border border-border bg-background p-1.5"
        />
        <button
          type="button"
          disabled={!newEntry.trim()}
          onClick={() => {
            const path = newEntry.trim();
            if (draft.targets.some((t) => t.mainFile === path)) {
              setError("该入口已存在");
              return;
            }
            const target = makeBuildTarget(path);
            setDraft((current) => ({
              ...current,
              targets: [...current.targets, target],
              activeTarget: current.activeTarget ?? target.id,
            }));
            setNewEntry("");
          }}
          className="border border-border px-2"
        >
          添加目标
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const targets = await invoke<BuildTarget[]>("latex_scan_targets", {
                directory: project,
              });
              setDraft((current) => ({
                ...current,
                targets: [
                  ...current.targets,
                  ...targets.filter(
                    (t) => !current.targets.some((old) => old.mainFile === t.mainFile),
                  ),
                ],
                activeTarget: current.activeTarget ?? targets[0]?.id ?? null,
              }));
            })
          }
          className="border border-border px-2"
        >
          扫描入口
        </button>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await onSave(draft);
          })
        }
        className="border border-foreground bg-foreground px-3 py-1.5 text-background"
      >
        {busy ? "正在保存…" : "保存编译配置"}
      </button>
      {error && (
        <p role="alert" className="whitespace-pre-wrap text-red-600">
          {error}
        </p>
      )}
      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer">本机编译器 · 自动探测与路径覆盖</summary>
        <p className="my-2 text-muted">
          本机路径不会写入项目配置。覆盖失效时会重新自动查找；新电脑仍需安装 LaTeX
          环境及模板需要的字体。
        </p>
        <button
          type="button"
          onClick={() =>
            void run(async () =>
              setCatalog(await invoke<LaTeXCompilersStatus>("latex_detect_compilers")),
            )
          }
          className="mb-2 border border-border px-2 py-1"
        >
          重新检测编译器
        </button>
        {["pdflatex", "xelatex", "lualatex", "latexmk", "tectonic"].map((engine) => (
          <label key={engine} className="mb-2 block">
            {engine}{" "}
            <span className="text-muted">
              {catalog?.[engine as keyof LaTeXCompilersStatus]?.path ?? (catalog ? "未找到" : "")}
            </span>
            <input
              aria-label={`${engine} 本机路径覆盖`}
              value={overrides[engine] || ""}
              placeholder="留空自动探测"
              onChange={(e) => {
                const next = { ...overrides, [engine]: e.target.value };
                setOverrides(next);
                writeCompilerOverrides(next);
              }}
              className="mt-1 w-full border border-border bg-background p-1.5 font-mono"
            />
          </label>
        ))}
      </details>
    </section>
  );
}
