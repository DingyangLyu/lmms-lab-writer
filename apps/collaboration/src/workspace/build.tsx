import { useEffect, useState } from "react";
import type { Build, Engine, PdfRegion, SourceFile, SourceLocation } from "../../shared/api";
import { api } from "../api";
import { useI18n } from "../i18n";
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
  const { t } = useI18n();
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
      ws.report(t("build.missingFile", { path }));
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
      if (!chosenMain) throw new Error(t("build.noTex"));
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
  const { t } = useI18n();
  return (
    <div className="row compile-controls">
      <select
        aria-label={t("build.main")}
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
        aria-label={t("build.engine")}
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
        title={ws.status === "saving" ? t("build.waitSync") : t("build.onServer")}
        onClick={b.compile}
      >
        {b.compiling ? t("build.compiling") : t("build.compile")}
      </button>
      <button type="button" onClick={() => b.setOpen(!b.open)}>
        {b.open ? t("build.hidePdf") : t("build.showPdf")}
      </button>
      {b.build?.pdf && ws.file && !ws.file.binary && (
        <button type="button" title={t("build.forwardTitle")} onClick={b.showCursorInPdf}>
          {t("build.forward")}
        </button>
      )}
    </div>
  );
}

export function BuildPane({ prefix, b }: { prefix: string; b: BuildState }) {
  const { t, locale } = useI18n();
  const { build } = b;
  const errors = build?.issues.filter((i) => i.level === "error") ?? [],
    warnings = build?.issues.filter((i) => i.level === "warning") ?? [];
  return (
    <aside className="pdf-pane" aria-label={t("build.preview")}>
      <div className="build-status">
        {b.compiling ? (
          <span>{t("build.running")}</span>
        ) : build ? (
          <span className={build.status === "success" ? "ok" : "failed"}>
            {build.status === "success" ? t("build.success") : t("build.failed")} · {build.main} ·{" "}
            {t("build.seconds", { seconds: (build.duration / 1000).toFixed(1) })} ·{" "}
            {new Date(build.created).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en")}
          </span>
        ) : (
          <span className="muted">{t("build.none")}</span>
        )}
        {build?.pdf && (
          <a href={`/api${prefix}/builds/${build.id}/pdf`} download="output.pdf">
            {t("build.download")}
          </a>
        )}
      </div>
      {!!build?.issues.length && (
        <details className="build-issues" open={!!errors.length}>
          <summary>
            {t("build.issues", { errors: errors.length, warnings: warnings.length })}
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
        build && <p className="muted pdf-empty">{t("build.noPdf")}</p>
      )}
      {build && (
        <details className="build-log">
          <summary>{t("build.log")}</summary>
          <pre>{build.log}</pre>
        </details>
      )}
    </aside>
  );
}
