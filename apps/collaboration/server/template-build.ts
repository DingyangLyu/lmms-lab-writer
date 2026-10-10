/**
 * Builds the official conference and journal templates into the template library from the
 * venues' own author kits:
 *
 *   tsx server/template-build.ts --out <library> [--cache <dir>] [--only id,id] [--no-render]
 *
 * template-library/sources.json lists each kit: where it is downloaded from, which folder of the
 * archive is the project, what to generate or leave out, the main file and engine, and how the
 * gallery describes it. Archives are kept in the cache folder (default <library>/.cache); a kit
 * behind a bot check can be saved there by hand under its `archive` name. Each template is
 * written beside the old one and swapped in only when it is complete; its preview is built with
 * WRITER_LATEXMK and Ghostscript (WRITER_GHOSTSCRIPT, or `rungs` beside latexmk).
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { validPath } from "@lmms-lab/sync";
import { unzipSync } from "fflate";
import type { Engine } from "../shared/api";
import { renderPreview } from "./template-render";
import type { TemplateMeta } from "./templates";

export type Source = {
  id: string;
  url: string;
  /** File name in the cache. */
  archive: string;
  /** Folder in the archive that is the project; default the archive's single top folder. */
  root?: string;
  /** `.ins` files run through TeX first, e.g. to make a class and its samples from `.dtx`. */
  generate?: string[];
  /** Files kept after generating (globs); default all. */
  include?: string[];
  exclude?: string[];
  /** Moves, e.g. a sample out of `samples/`. */
  rename?: Record<string, string>;
  /** Files of our own (relative to template-library/), e.g. a sample for a bare class. */
  add?: Record<string, string>;
  main: string;
  engine?: Engine;
  meta: Omit<TemplateMeta, "main" | "engine" | "fileCount" | "bytes" | "preview" | "updated">;
};
const LIBRARY_SOURCES = join(import.meta.dirname, "../template-library");
const ALWAYS_EXCLUDED = [
  "__MACOSX/**",
  "**/.DS_Store",
  "**/.github/**",
  "**/.git/**",
  "**/.git*",
  "**/Thumbs.db",
];

export function glob(pattern: string) {
  const literal = (s: string) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  const body = pattern
    .split("**/")
    .map((part) =>
      part
        .split("**")
        .map((p) => p.split("*").map(literal).join("[^/]*"))
        .join(".*"),
    )
    .join("(?:.*/)?");
  return new RegExp(`^${body}$`);
}
const matches = (patterns: string[] | undefined, path: string) =>
  !!patterns?.some((p) => glob(p).test(path));

/** The project files of a kit, as relative path → bytes. */
export function unpackKit(zip: Uint8Array, source: Source) {
  const entries = unzipSync(zip);
  const names = Object.keys(entries)
    .map((n) => n.replace(/\\/g, "/"))
    .filter((n) => !n.endsWith("/") && !matches(ALWAYS_EXCLUDED, n));
  let root = source.root;
  if (root === undefined) {
    const top = names[0]?.split("/")[0] ?? "";
    root = names.length && names.every((n) => n.startsWith(`${top}/`)) ? top : "";
  }
  const prefix = root ? `${root.replace(/\/$/, "")}/` : "";
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    const path = name.replace(/\\/g, "/");
    if (path.endsWith("/") || !path.startsWith(prefix) || matches(ALWAYS_EXCLUDED, path)) continue;
    files.set(path.slice(prefix.length), data);
  }
  return files;
}

async function walk(root: string, dir = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(root, path)));
    else found.push(relative(root, path).split(sep).join("/"));
  }
  return found;
}
function tex(file: string, latexmk: string | undefined) {
  const binary =
    latexmk && /[\\/]/.test(latexmk)
      ? join(dirname(latexmk), process.platform === "win32" ? "tex.exe" : "tex")
      : "tex";
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["-interaction=batchmode", file.split("/").pop() ?? file], {
      cwd: dirname(file),
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tex ${file} exited with ${code}`)),
    );
  });
}

async function download(source: Source, cache: string) {
  const path = join(cache, source.archive);
  if (await stat(path).catch(() => null)) return path;
  const response = await fetch(source.url, {
    headers: { "User-Agent": "Mozilla/5.0 (Y-Writer template library)" },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new Error(
      `${source.url} did not give a zip (HTTP ${response.status}); download it by hand to ${path}`,
    );
  await mkdir(cache, { recursive: true });
  await writeFile(path, bytes);
  return path;
}

/** Writes one template into `out` (replacing an older build of it) and returns its summary. */
export async function buildTemplate(
  source: Source,
  options: { out: string; cache: string; render: boolean; latexmk?: string; ghostscript?: string },
) {
  const archive = await download(source, options.cache);
  const kit = unpackKit(await readFile(archive), source);
  const dir = join(options.out, `${source.id}.partial`),
    files = join(dir, "files");
  await rm(dir, { recursive: true, force: true });
  for (const [path, data] of kit) {
    const target = join(files, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  for (const ins of source.generate ?? [])
    await tex(join(files, ...ins.split("/")), options.latexmk);
  for (const path of await walk(files))
    if (
      (source.include && !matches(source.include, path)) ||
      matches(source.exclude, path) ||
      !validPath(path)
    )
      await rm(join(files, ...path.split("/")));
  for (const [from, to] of Object.entries(source.rename ?? {})) {
    await mkdir(dirname(join(files, ...to.split("/"))), { recursive: true });
    await rename(join(files, ...from.split("/")), join(files, ...to.split("/")));
  }
  for (const [to, from] of Object.entries(source.add ?? {})) {
    await mkdir(dirname(join(files, ...to.split("/"))), { recursive: true });
    await copyFile(join(LIBRARY_SOURCES, ...from.split("/")), join(files, ...to.split("/")));
  }
  await removeEmpty(files);
  const paths = await walk(files);
  if (!paths.includes(source.main)) throw new Error(`${source.id}: no ${source.main} in the kit`);
  let bytes = 0;
  for (const p of paths) bytes += (await stat(join(files, ...p.split("/")))).size;
  const engine = source.engine ?? "pdflatex";
  const preview = options.render
    ? await renderPreview(dir, files, source.main, engine, {
        compile: { latexmk: options.latexmk, timeoutMs: 240_000 },
        ghostscript: options.ghostscript,
      })
    : { status: "none", pages: 0, log: null };
  const meta: TemplateMeta = {
    ...source.meta,
    source: source.url,
    official: true,
    main: source.main,
    engine,
    updated: Date.now(),
    fileCount: paths.length,
    bytes,
    preview,
  };
  await writeFile(join(dir, "template.json"), `${JSON.stringify(meta, null, 2)}\n`);
  const final = join(options.out, source.id);
  const old = `${final}.old`;
  await rm(old, { recursive: true, force: true });
  if (await stat(final).catch(() => null)) await rename(final, old);
  await rename(dir, final);
  await rm(old, { recursive: true, force: true });
  return { id: source.id, files: paths.length, bytes, preview };
}
async function removeEmpty(dir: string): Promise<boolean> {
  let empty = true;
  for (const entry of await readdir(dir, { withFileTypes: true }))
    if (!entry.isDirectory() || !(await removeEmpty(join(dir, entry.name)))) empty = false;
  if (empty) await rm(dir, { recursive: true, force: true });
  return empty;
}

export async function loadSources(path = join(LIBRARY_SOURCES, "sources.json")) {
  return JSON.parse(await readFile(path, "utf8")) as Source[];
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      cache: { type: "string" },
      only: { type: "string" },
      "no-render": { type: "boolean" },
      sources: { type: "string" },
    },
  });
  const out =
    values.out ||
    process.env.WRITER_TEMPLATE_LIBRARY ||
    join(process.env.WRITER_DATA_DIR || ".data", "templates");
  const cache = values.cache || join(out, ".cache");
  const only = values.only?.split(",").map((s) => s.trim());
  await mkdir(out, { recursive: true });
  let failed = 0;
  for (const source of await loadSources(values.sources)) {
    if (only && !only.includes(source.id)) continue;
    try {
      const built = await buildTemplate(source, {
        out,
        cache,
        render: !values["no-render"],
        latexmk: process.env.WRITER_LATEXMK,
        ghostscript: process.env.WRITER_GHOSTSCRIPT,
      });
      console.log(
        `${built.id}: ${built.files} files, ${Math.round(built.bytes / 1000)} kB, preview ${built.preview.status} (${built.preview.pages} pages)`,
      );
      if (built.preview.status === "failed") console.log(`  ${built.preview.log?.slice(-600)}`);
    } catch (error) {
      failed++;
      console.error(`${source.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) await main();
