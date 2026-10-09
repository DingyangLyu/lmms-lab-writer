/**
 * Project templates: folders holding a `template.json` and the project's files. Built-in
 * templates ship in ../templates; an operator can add a lab's own (thesis, group report…)
 * with WRITER_TEMPLATES_DIR. A template there with a built-in's id replaces it.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { validPath } from "@lmms-lab/sync";
import type { Engine, TemplateInfo } from "../shared/api";
import { engines } from "./compile";

export type Template = TemplateInfo & {
  files: Array<{ path: string; data: Uint8Array }>;
  previewFile: string | null;
};
const META = "template.json",
  PREVIEW = "preview.png";

async function walk(root: string, dir = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(root, path)));
    else if (entry.isFile()) found.push(relative(root, path).split(sep).join("/"));
  }
  return found;
}
const text = (value: unknown, fallback: string) => {
  const v = value as { zh?: unknown; en?: unknown } | undefined;
  const zh = typeof v?.zh === "string" ? v.zh : fallback;
  return { zh, en: typeof v?.en === "string" ? v.en : zh };
};

async function load(dir: string, id: string): Promise<Template | null> {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(await readFile(join(dir, META), "utf8"));
  } catch {
    return null;
  }
  const files: Template["files"] = [];
  let previewFile: string | null = null;
  for (const path of (await walk(dir)).sort()) {
    if (path === META) continue;
    if (path === PREVIEW) {
      previewFile = join(dir, PREVIEW);
      continue;
    }
    if (!validPath(path)) continue;
    files.push({ path, data: await readFile(join(dir, ...path.split("/"))) });
  }
  const main = typeof meta.main === "string" ? meta.main : "main.tex";
  if (!files.some((f) => f.path === main)) return null;
  const engine = engines.includes(meta.engine as Engine) ? (meta.engine as Engine) : "pdflatex";
  return {
    id,
    name: text(meta.name, id),
    description: text(meta.description, ""),
    category: typeof meta.category === "string" ? meta.category : "other",
    main,
    engine,
    order: typeof meta.order === "number" ? meta.order : 100,
    preview: !!previewFile,
    fileCount: files.length,
    files,
    previewFile,
  };
}

/** Reads every template once; later directories override earlier ones with the same id. */
export async function loadTemplates(directories: string[]): Promise<Map<string, Template>> {
  const found = new Map<string, Template>();
  for (const root of directories) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) continue;
      const dir = join(root, entry.name);
      if (!(await stat(join(dir, META)).catch(() => null))) continue;
      const template = await load(dir, entry.name);
      if (template) found.set(template.id, template);
    }
  }
  return new Map(
    [...found.values()]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((t) => [t.id, t]),
  );
}

export const templateInfo = ({ files: _files, previewFile: _preview, ...info }: Template) =>
  info satisfies TemplateInfo;
