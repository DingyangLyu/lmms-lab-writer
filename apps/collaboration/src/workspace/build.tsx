import { useEffect, useState } from "react";
import type { Build, Engine, PdfRegion, SourceFile, SourceLocation } from "../../shared/api";
import { api } from "../api";
import { PdfViewer } from "../pdf-viewer";
import type { WorkspaceContext } from "./context";

const needsXeLaTeX = (sources: SourceFile[]) =>
  sources.some((f) =>
    /\\usepackage(\[[^\]]*\])?\{(ctex|xeCJK|fontspec)\}|\\documentclass(\[[^\]]*\])?\{ctex/.test(
      f.content,
    ),
  );

/** Server builds for the open project, PDF highlights and source <-> PDF jumps. */
export function useBuild(ws: WorkspaceContext, latest: Build | null, sources: SourceFile[]) {
  const [build, setBuild] = useState<Build | null>(null),
    [compiling, setCompiling] = useState(false),
    [open, setOpen] = useState(true),
    [main, setMain] = useState(""),
    [engine, setEngine] = useState<Engine | "">(""),
    [highlight, setHighlight] = useState<PdfRegion | null>(null),
    [reveal, setReveal] = useState<{ file: string; line: number } | null>(null);
  // A collaborator's newer build replaces the one shown here.
  useEffect(() => {
    setBuild((old) => (latest && (!old || latest.created >= old.created) ? latest : old));
  }, [latest]);
  const texFiles = ws.files.filter((f) => !f.binary && f.path.endsWith(".tex"));
  const chosenMain =
    main ||
    build?.main ||
    (texFiles.some((f) => f.path === "main.tex") ? "main.tex" : (texFiles[0]?.path ?? ""));
  const chosenEngine: Engine =
    engine || build?.engine || (needsXeLaTeX(sources) ? "xelatex" : "pdflatex");
  const { file, files, editor, status, openFile } = ws;
  /** Open a source location: switch files if needed, then move the cursor once it loaded. */
  const openLocation = (path: string, line: number) => {
    const target = files.find((f) => f.path === path);
    if (!target) {
      ws.report(`项目中没有 ${path}`);
      return;
    }
    if (file?.id === target.id) editor.current?.reveal(line);
    else {
      openFile(target);
      setReveal({ file: target.id, line });
    }
  };
  useEffect(() => {
    if (reveal && file?.id === reveal.file && status === "saved") {
      editor.current?.reveal(reveal.line);
      setReveal(null);
    }
  }, [reveal, file, status, editor]);
  const compile = () =>
    ws.run(async () => {
      if (!chosenMain) throw new Error("项目里还没有 .tex 文件");
      setCompiling(true);
      try {
        setBuild(
          await api<Build>(`${ws.prefix}/builds`, { main: chosenMain, engine: chosenEngine }),
        );
        setHighlight(null);
        setOpen(true);
      } finally {
        setCompiling(false);
      }
    });
  const showCursorInPdf = () =>
    build &&
    file &&
    ws.run(async () => {
      const line = editor.current?.line() ?? 1;
      setHighlight(
        await api<PdfRegion>(
          `${ws.prefix}/builds/${build.id}/forward?file=${encodeURIComponent(file.path)}&line=${line}`,
        ),
      );
      setOpen(true);
    });
  const showPdfInSource = (page: number, x: number, y: number) =>
    build &&
    ws.run(async () => {
      const hit = await api<SourceLocation>(
        `${ws.prefix}/builds/${build.id}/inverse?page=${page}&x=${x}&y=${y}`,
      );
      openLocation(hit.file, hit.line);
    });
  return {
    build,
    compiling,
    open,
    setOpen,
    texFiles,
    chosenMain,
    setMain,
    chosenEngine,
    setEngine,
    highlight,
    compile,
    showCursorInPdf,
    showPdfInSource,
    openLocation,
  };
}
export type BuildState = ReturnType<typeof useBuild>;

export function BuildControls({ ws, b }: { ws: WorkspaceContext; b: BuildState }) {
  return (
    <div className="row compile-controls">
      <select
        aria-label="编译主文件"
        value={b.chosenMain}
        onChange={(e) => b.setMain(e.target.value)}
      >
        {b.texFiles.map((f) => (
          <option key={f.id} value={f.path}>
            {f.path}
          </option>
        ))}
      </select>
      <select
        aria-label="编译器"
        value={b.chosenEngine}
        onChange={(e) => b.setEngine(e.target.value as Engine)}
      >
        <option value="pdflatex">pdfLaTeX</option>
        <option value="xelatex">XeLaTeX</option>
        <option value="lualatex">LuaLaTeX</option>
      </select>
      <button
        type="button"
        className="primary"
        disabled={!ws.canComment || b.compiling || !b.texFiles.length || ws.status === "saving"}
        title={ws.status === "saving" ? "等待正文同步完成" : "在服务器上编译"}
        onClick={b.compile}
      >
        {b.compiling ? "编译中…" : "编译"}
      </button>
      <button type="button" onClick={() => b.setOpen(!b.open)}>
        {b.open ? "隐藏 PDF" : "显示 PDF"}
      </button>
      {b.build?.pdf && ws.file && !ws.file.binary && (
        <button type="button" title="跳到光标所在行在 PDF 中的位置" onClick={b.showCursorInPdf}>
          定位到 PDF
        </button>
      )}
    </div>
  );
}

export function BuildPane({ prefix, b }: { prefix: string; b: BuildState }) {
  const { build } = b;
  const errors = build?.issues.filter((i) => i.level === "error") ?? [],
    warnings = build?.issues.filter((i) => i.level === "warning") ?? [];
  return (
    <aside className="pdf-pane" aria-label="PDF 预览">
      <div className="build-status">
        {b.compiling ? (
          <span>正在服务器上编译…</span>
        ) : build ? (
          <span className={build.status === "success" ? "ok" : "failed"}>
            {build.status === "success" ? "编译成功" : "编译有错误"} · {build.main} ·{" "}
            {(build.duration / 1000).toFixed(1)} 秒 · {new Date(build.created).toLocaleTimeString()}
          </span>
        ) : (
          <span className="muted">还没有编译结果，点击“编译”。</span>
        )}
        {build?.pdf && (
          <a href={`/api${prefix}/builds/${build.id}/pdf`} download="output.pdf">
            下载 PDF
          </a>
        )}
      </div>
      {!!build?.issues.length && (
        <details className="build-issues" open={!!errors.length}>
          <summary>
            {errors.length} 个错误 · {warnings.length} 个警告
          </summary>
          {[...errors, ...warnings].map((issue, i) => (
            <button
              type="button"
              // biome-ignore lint/suspicious/noArrayIndexKey: Issues of one immutable build.
              key={i}
              className={`issue ${issue.level}`}
              disabled={!issue.file || !issue.line}
              onClick={() => issue.file && issue.line && b.openLocation(issue.file, issue.line)}
            >
              {issue.file && issue.line ? `${issue.file}:${issue.line} ` : ""}
              {issue.message}
            </button>
          ))}
        </details>
      )}
      {build?.pdf ? (
        <PdfViewer
          url={`/api${prefix}/builds/${build.id}/pdf`}
          highlight={b.highlight}
          onInverse={b.showPdfInSource}
        />
      ) : (
        build && <p className="muted pdf-empty">这次编译没有生成 PDF，请根据错误或日志修改。</p>
      )}
      {build && (
        <details className="build-log">
          <summary>完整日志</summary>
          <pre>{build.log}</pre>
        </details>
      )}
    </aside>
  );
}
