import { buildEngine } from "@lmms-lab/writing";
import { useEffect, useRef, useState } from "react";
import type {
  Build,
  Engine,
  FileContent,
  PdfRegion,
  SourceFile,
  SourceLocation,
} from "../../shared/api";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";

/** pdfLaTeX's error for a Chinese, Japanese or Korean character it cannot typeset. */
const CJK_ERROR = /Unicode character \S+ \(U\+(?:2E[89A-F]|[3-9][0-9A-F]|F[9A]|FF)[0-9A-F]{2}\)/;
/** XeTeX's or LuaTeX's warning for such a character missing from the font. */
const CJK_MISSING = /^Missing character: There is no [\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
/** The engine nobody chose, by the rules the desktop and the server use too. */
const autoEngine = (sources: SourceFile[], main: string): Engine =>
  buildEngine((path) => sources.find((f) => f.path === path)?.content, main);

/** Server builds for the open project, PDF highlights and source <-> PDF jumps. */
const phone = () =>
  typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches;

export function useBuild(
  ws: WorkspaceContext,
  latest: Build | null,
  sources: SourceFile[],
  /** The project's files, latest build and sources have been read. */
  loaded = true,
) {
  const { t } = useI18n();
  const [build, setBuild] = useState<Build | null>(null),
    [compiling, setCompiling] = useState(false),
    // Phones show the editor first; the PDF takes the whole screen when opened.
    [open, setOpen] = useState(() => !phone()),
    [main, setMain] = useState(""),
    // "auto": chosen by the sources at every build, as the desktop's targets do by default.
    [engine, setEngine] = useState<Engine | "auto" | "">(""),
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
  const engineSetting: Engine | "auto" = engine || (build && !build.auto ? build.engine : "auto");
  const chosenEngine: Engine =
    engineSetting === "auto" ? autoEngine(sources, chosenMain) : engineSetting;
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
  const build_ = async (engineNow: Engine) => {
    if (!chosenMain) throw new Error(t("build.noTex"));
    setCompiling(true);
    try {
      setBuild(await api<Build>(`${ws.prefix}/builds`, { main: chosenMain, engine: engineNow }));
      setHighlight(null);
      setOpen(true);
    } finally {
      setCompiling(false);
    }
  };
  /**
   * Chinese text the build could not show: pdfLaTeX stopped at it, or the font had no glyphs
   * for it. Either way the main file gets ctex, and XeLaTeX builds it.
   */
  const chinese: "pdflatex" | "font" | null = !build
    ? null
    : build.status === "failed" &&
        build.engine === "pdflatex" &&
        build.issues.some((i) => CJK_ERROR.test(i.message))
      ? "pdflatex"
      : build.engine !== "pdflatex" && build.issues.some((i) => CJK_MISSING.test(i.message))
        ? "font"
        : null;
  const fixChinese = () =>
    ws.run(async () => {
      const target = files.find((f) => f.path === chosenMain && !f.binary);
      if (!target) throw new Error(t("build.noTex"));
      const current = await api<FileContent>(`${ws.prefix}/files/${target.id}`);
      const text = "content" in current ? current.content : "";
      if (!/\\usepackage(\[[^\]]*\])?\{ctex\}/.test(text)) {
        const next = text.replace(
          /(\\documentclass(\[[^\]]*\])?\{[^}]*\}[^\n]*\n)/,
          "$1\\usepackage[UTF8]{ctex}\n",
        );
        if (next === text) throw new Error(t("build.chineseManual"));
        await api(`${ws.prefix}/files/${target.id}`, { expected: text, content: next }, "PUT");
      }
      setEngine("xelatex");
      await build_("xelatex");
    });
  /** `show: false` builds without switching a phone to the PDF. */
  const compile = (show?: unknown) =>
    ws.run(async () => {
      if (!chosenMain) throw new Error(t("build.noTex"));
      setCompiling(true);
      try {
        setBuild(
          // Automatic: the server chooses from the text it builds, which the page's copy of
          // the sources may lag behind.
          await api<Build>(`${ws.prefix}/builds`, {
            main: chosenMain,
            engine: engineSetting === "auto" ? "auto" : chosenEngine,
          }),
        );
        setHighlight(null);
        if (show !== false) setOpen(true);
      } finally {
        setCompiling(false);
      }
    });
  // A project that was never built gets a PDF on opening, as on Overleaf.
  const autoCompiled = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening, when everything it needs is known.
  useEffect(() => {
    if (autoCompiled.current || !loaded || latest || build || compiling) return;
    if (!chosenMain || !ws.canComment) return;
    autoCompiled.current = true;
    compile(!phone());
  }, [loaded, latest, build, chosenMain, ws.canComment]);
  // Automatic builds (this browser's choice): a few seconds after the member's edits are saved.
  const [autoBuild, setAutoBuildState] = useState(() => {
    try {
      return localStorage.getItem("writer-auto-compile") === "1";
    } catch {
      return false;
    }
  });
  const setAutoBuild = (on: boolean) => {
    setAutoBuildState(on);
    try {
      localStorage.setItem("writer-auto-compile", on ? "1" : "0");
    } catch {}
  };
  const lastStatus = useRef(status);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoPending = useRef(false);
  // The timer runs later: it calls the newest compile, with the newest settings.
  const compileNow = useRef(compile);
  compileNow.current = compile;
  const compilingNow = useRef(compiling);
  compilingNow.current = compiling;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to saves only.
  useEffect(() => {
    const saved = lastStatus.current === "saving" && status === "saved";
    lastStatus.current = status;
    if (!autoBuild || !saved || !ws.canComment) return;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      if (compilingNow.current) autoPending.current = true;
      else compileNow.current(false);
    }, 2500);
  }, [status, autoBuild]);
  // A build asked for while another ran starts when that one ends.
  useEffect(() => {
    if (!compiling && autoPending.current) {
      autoPending.current = false;
      compileNow.current(false);
    }
  }, [compiling]);
  useEffect(
    () => () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    },
    [],
  );
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
    engineSetting,
    setEngine,
    autoBuild,
    setAutoBuild,
    highlight,
    compile,
    chinese,
    fixChinese,
    showCursorInPdf,
    showPdfInSource,
    openLocation,
  };
}
export type BuildState = ReturnType<typeof useBuild>;
