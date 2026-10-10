/**
 * A template's preview: its sample PDF, built with latexmk in a scratch directory, and the first
 * pages as PNG (plus a small thumbnail for the gallery), rendered with Ghostscript. TeX Live
 * ships Ghostscript as `rungs` beside latexmk (on Windows with its own copy), so a server that
 * can build PDFs can render previews too.
 */
import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type CompileOptions, type Engine, runLatexmk } from "./compile";
import { OUTPUT_DIR } from "./synctex";

export type RenderOptions = {
  compile?: CompileOptions;
  /** Ghostscript; default `rungs` beside latexmk, else `gs` from PATH. */
  ghostscript?: string;
};
export type RenderResult = { status: "ready" | "failed"; pages: number; log: string | null };
/** Pages shown on a template's page, and the resolutions of those pages and of the thumbnail. */
export const PREVIEW_PAGES = 4;
const PAGE_DPI = 110,
  THUMB_DPI = 48;

export function ghostscriptFor(options: RenderOptions) {
  if (options.ghostscript) return options.ghostscript;
  const latexmk = options.compile?.latexmk;
  if (latexmk && /[\\/]/.test(latexmk))
    return join(dirname(latexmk), process.platform === "win32" ? "rungs.exe" : "rungs");
  return "gs";
}

function run(command: string, args: string[], cwd: string, timeoutMs = 60_000) {
  return new Promise<{ code: number | null; text: string }>((resolve) => {
    let text = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: -1, text: String(error) });
      return;
    }
    const append = (chunk: Buffer) => {
      text = (text + chunk.toString()).slice(-8000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, text: `${text}\n${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, text });
    });
  });
}

/** `page-1.png`… from a PDF; returns how many pages were written. */
export async function renderPages(
  pdf: string,
  out: string,
  pages: number,
  options: RenderOptions,
  prefix = "page",
  dpi = PAGE_DPI,
) {
  const result = await run(
    ghostscriptFor(options),
    [
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-dQUIET",
      "-sDEVICE=png16m",
      "-dTextAlphaBits=4",
      "-dGraphicsAlphaBits=4",
      `-r${dpi}`,
      "-dFirstPage=1",
      `-dLastPage=${pages}`,
      `-sOutputFile=${join(out, `${prefix}-%d.png`)}`,
      pdf,
    ],
    out,
  );
  const written = (await readdir(out)).filter((f) => new RegExp(`^${prefix}-\\d+\\.png$`).test(f));
  return { count: written.length, log: result.code === 0 ? null : result.text.slice(-4000) };
}

/**
 * Builds `files` (a template's project folder) and writes `preview/` beside it: sample.pdf,
 * page-N.png and thumb.png. The old preview stays until the new one is complete.
 */
export async function renderPreview(
  templateDir: string,
  files: string,
  main: string,
  engine: Engine,
  options: RenderOptions,
): Promise<RenderResult> {
  const build = await mkdtemp(join(tmpdir(), "writer-template-"));
  try {
    await cp(files, build, { recursive: true });
    const output = await runLatexmk(build, main, engine, options.compile ?? {});
    const pdf = join(build, OUTPUT_DIR, `${basename(main, ".tex")}.pdf`);
    if (!(await stat(pdf).catch(() => null)))
      return {
        status: "failed",
        pages: 0,
        log: output.timedOut ? "Timed out" : output.text.slice(-6000),
      };
    const next = join(templateDir, "preview.partial");
    await rm(next, { recursive: true, force: true });
    await mkdir(next, { recursive: true });
    await copyFile(pdf, join(next, "sample.pdf"));
    const pages = await renderPages(pdf, next, PREVIEW_PAGES, options);
    const thumb = await renderPages(pdf, next, 1, options, "thumb", THUMB_DPI);
    if (thumb.count) await rename(join(next, "thumb-1.png"), join(next, "thumb.png"));
    const current = join(templateDir, "preview");
    await rm(current, { recursive: true, force: true });
    await rename(next, current);
    // A PDF with warnings or recoverable errors is still a fine preview.
    const log = pages.log ?? (output.code === 0 ? null : output.text.slice(-6000));
    return { status: "ready", pages: pages.count, log };
  } finally {
    await rm(build, { recursive: true, force: true });
  }
}
