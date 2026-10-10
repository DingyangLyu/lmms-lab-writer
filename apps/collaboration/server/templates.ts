/**
 * The template library. A template is a folder named by its id:
 *
 *   <id>/template.json      name, venue, fields… (see TemplateMeta)
 *   <id>/files/…            the project; built-ins keep their files beside template.json
 *   <id>/preview/           sample.pdf, page-1.png…, thumb.png (built-ins: preview.png)
 *
 * Built-ins ship in ../templates; WRITER_TEMPLATES_DIR adds a lab's own, read-only; the library
 * folder (WRITER_TEMPLATE_LIBRARY, e.g. on a data disk) holds the official conference kits that
 * template-build.ts fetches and the templates members publish. A later folder's template replaces
 * an earlier one with the same id.
 *
 * Listing reads template.json files only, kept as an index for half a minute; a template's files
 * are read when a project is made from it. A library on a removable disk that is missing just
 * leaves its templates out until it is back.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { validPath } from "@lmms-lab/sync";
import type {
  Engine,
  Localized,
  TemplateDetail,
  TemplateInfo,
  TemplateInput,
  TemplateList,
} from "../shared/api";
import { templateCategories, templateFields } from "../shared/api";
import { engines } from "./compile";
import { type RenderOptions, renderPreview } from "./template-render";
import { fail } from "./util";

export type TemplateFile = { path: string; data: Uint8Array };
type Origin = "builtin" | "lab" | "library";
type Root = { dir: string; origin: Origin };
/** template.json as written by template-build.ts and by publishing. */
export type TemplateMeta = {
  name?: Partial<Localized>;
  description?: Partial<Localized>;
  category?: string;
  main?: string;
  engine?: string;
  order?: number;
  venue?: string | null;
  year?: number | null;
  venues?: string[];
  fields?: string[];
  tags?: string[];
  source?: string | null;
  homepage?: string | null;
  official?: boolean;
  author?: { id: string; name: string } | null;
  updated?: number;
  fileCount?: number;
  bytes?: number;
  preview?: { status?: string; pages?: number; log?: string | null };
};
type Entry = {
  info: TemplateInfo;
  meta: TemplateMeta;
  dir: string;
  /** Where the project files are: `files/`, or the template folder itself (built-ins). */
  files: string;
  root: Root;
  thumb: string | null;
};
const META = "template.json";
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A published template is a starting point, not an archive of a project. */
export const TEMPLATE_BYTES = 100_000_000,
  TEMPLATE_FILES = 1000;
const INDEX_MS = 30_000;

const localized = (value: Partial<Localized> | undefined, fallback: string): Localized => {
  const zh = typeof value?.zh === "string" && value.zh ? value.zh : fallback;
  return { zh, en: typeof value?.en === "string" && value.en ? value.en : zh };
};
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

async function walk(root: string, dir = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(root, path)));
    else if (entry.isFile()) found.push(relative(root, path).split(sep).join("/"));
  }
  return found;
}
/** A built-in's own files are its project files, minus the metadata and preview. */
const projectPath = (entry: Pick<Entry, "files" | "dir">, path: string) =>
  validPath(path) &&
  !(
    entry.files === entry.dir &&
    (path === META || path === "preview.png" || /^preview\//.test(path))
  );

async function writeJson(path: string, data: unknown) {
  await writeFile(`${path}.partial`, `${JSON.stringify(data, null, 2)}\n`);
  await rename(`${path}.partial`, path);
}

/** Checks what a member typed for a template; the server words the errors. */
export function templateInput(body: Record<string, unknown>): TemplateInput {
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim().length <= max ? value.trim() : null;
  const pair = (key: string, max: number, required: boolean): Localized => {
    const value = body[key] as Partial<Localized> | undefined;
    const zh = text(value?.zh, max) ?? "",
      en = text(value?.en, max) ?? "";
    if (required && !zh && !en) fail(400, "请填写模板名称");
    if (
      (value?.zh !== undefined && text(value.zh, max) === null) ||
      (value?.en !== undefined && text(value.en, max) === null)
    )
      fail(400, "无效字段 {key}", { key });
    return { zh: zh || en, en: en || zh };
  };
  const category = String(body.category ?? "other");
  if (!(templateCategories as readonly string[]).includes(category))
    fail(400, "无效字段 {key}", { key: "category" });
  const fields = strings(body.fields);
  if (fields.some((f) => !(templateFields as readonly string[]).includes(f)))
    fail(400, "无效字段 {key}", { key: "fields" });
  const tags = strings(body.tags)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length > 20 || tags.some((t) => t.length > 40))
    fail(400, "无效字段 {key}", { key: "tags" });
  const venue = body.venue === null || body.venue === undefined ? null : text(body.venue, 40);
  if (venue === null && body.venue) fail(400, "无效字段 {key}", { key: "venue" });
  const year =
    body.year === null || body.year === undefined || body.year === "" ? null : Number(body.year);
  if (year !== null && !(Number.isInteger(year) && year >= 1970 && year <= 2100))
    fail(400, "无效字段 {key}", { key: "year" });
  return {
    name: pair("name", 120, true),
    description: pair("description", 2000, false),
    category,
    fields: [...new Set(fields)],
    tags: [...new Set(tags)],
    venue: venue || null,
    year,
  };
}

export class TemplateLibrary {
  private roots: Root[];
  private index: Promise<Map<string, Entry>> | null = null;
  private indexed = 0;
  private rendering: Promise<void> = Promise.resolve();
  constructor(
    builtin: string,
    private options: { lab?: string; library?: string; render?: RenderOptions } = {},
  ) {
    this.roots = [
      { dir: builtin, origin: "builtin" },
      ...(options.lab ? [{ dir: options.lab, origin: "lab" as const }] : []),
      ...(options.library ? [{ dir: options.library, origin: "library" as const }] : []),
    ];
  }
  /** Forget the index, e.g. after the library folder changed. */
  refresh() {
    this.index = null;
  }
  private entries() {
    if (!this.index || Date.now() - this.indexed > INDEX_MS) {
      this.indexed = Date.now();
      this.index = this.scan();
    }
    return this.index;
  }
  private async scan() {
    const found = new Map<string, Entry>();
    for (const root of this.roots) {
      const children = await readdir(root.dir, { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        if (!child.isDirectory() || !ID.test(child.name)) continue;
        const entry = await this.load(root, child.name).catch(() => null);
        if (entry) found.set(entry.info.id, entry);
      }
    }
    return new Map(
      [...found.values()]
        .sort(
          (a, b) =>
            a.info.order - b.info.order ||
            (b.info.year ?? 0) - (a.info.year ?? 0) ||
            a.info.id.localeCompare(b.info.id),
        )
        .map((e) => [e.info.id, e]),
    );
  }
  private async load(root: Root, id: string): Promise<Entry | null> {
    const dir = join(root.dir, id);
    const meta = JSON.parse(await readFile(join(dir, META), "utf8")) as TemplateMeta;
    const nested = !!(await stat(join(dir, "files")).catch(() => null))?.isDirectory();
    const files = nested ? join(dir, "files") : dir;
    const shell = { dir, files };
    let fileCount = meta.fileCount,
      bytes = meta.bytes;
    const main = typeof meta.main === "string" ? meta.main : "main.tex";
    if (fileCount === undefined || bytes === undefined || !nested) {
      const paths = (await walk(files)).filter((p) => projectPath(shell, p));
      if (!paths.includes(main)) return null;
      fileCount = paths.length;
      bytes = 0;
      for (const p of paths) bytes += (await stat(join(files, ...p.split("/")))).size;
    }
    const previewDir = join(dir, "preview");
    const previewFiles = await readdir(previewDir).catch(() => [] as string[]);
    const pages = previewFiles.filter((f) => /^page-\d+\.png$/.test(f)).length;
    const legacy = (await stat(join(dir, "preview.png")).catch(() => null))
      ? join(dir, "preview.png")
      : null;
    const thumb = previewFiles.includes("thumb.png")
      ? join(previewDir, "thumb.png")
      : pages
        ? join(previewDir, "page-1.png")
        : legacy;
    const status = meta.preview?.status;
    const engine = engines.includes(meta.engine as Engine) ? (meta.engine as Engine) : "pdflatex";
    const info: TemplateInfo = {
      id,
      name: localized(meta.name, id),
      description: localized(meta.description, ""),
      category: typeof meta.category === "string" ? meta.category : "other",
      main,
      engine,
      order: typeof meta.order === "number" ? meta.order : 100,
      preview: !!thumb,
      fileCount,
      bytes,
      venue: typeof meta.venue === "string" ? meta.venue : null,
      year: typeof meta.year === "number" ? meta.year : null,
      venues: strings(meta.venues),
      fields: strings(meta.fields),
      tags: strings(meta.tags),
      source: typeof meta.source === "string" ? meta.source : null,
      homepage: typeof meta.homepage === "string" ? meta.homepage : null,
      pages,
      pdf: previewFiles.includes("sample.pdf"),
      previewStatus:
        status === "pending" || status === "failed" ? status : thumb ? "ready" : "none",
      origin:
        root.origin === "builtin"
          ? "builtin"
          : root.origin === "lab" || meta.official
            ? "official"
            : "member",
      author: meta.author && typeof meta.author.id === "string" ? meta.author : null,
      updated: typeof meta.updated === "number" ? meta.updated : null,
    };
    return { info, meta, dir, files, root, thumb };
  }

  private libraryRoot() {
    return this.roots.find((r) => r.origin === "library") ?? null;
  }
  async list(): Promise<TemplateList> {
    const entries = await this.entries();
    const root = this.libraryRoot();
    const available = !!root && !!(await stat(root.dir).catch(() => null));
    return {
      templates: [...entries.values()].map((e) => e.info),
      library: { available, writable: available },
    };
  }
  async get(id: string) {
    return (ID.test(id) ? (await this.entries()).get(id) : undefined) ?? fail(404, "模板不存在");
  }
  async detail(id: string): Promise<TemplateDetail> {
    const entry = await this.get(id);
    const files = [];
    for (const path of (await walk(entry.files).catch(() => [])).sort())
      if (projectPath(entry, path))
        files.push({ path, bytes: (await stat(join(entry.files, ...path.split("/")))).size });
    return {
      ...entry.info,
      files,
      previewLog: entry.info.previewStatus === "failed" ? (entry.meta.preview?.log ?? null) : null,
    };
  }
  /** The project files, read now: they may have changed since the index was made. */
  async files(id: string): Promise<TemplateFile[]> {
    const entry = await this.get(id);
    const paths = await walk(entry.files).catch(() => fail(503, "模板所在的磁盘暂时不可用"));
    const files: TemplateFile[] = [];
    for (const path of paths.sort())
      if (projectPath(entry, path))
        files.push({ path, data: await readFile(join(entry.files, ...path.split("/"))) });
    if (!files.some((f) => f.path === entry.info.main)) fail(404, "模板不存在");
    return files;
  }
  /** The gallery's thumbnail, a preview page (1-based) or the sample PDF. */
  async asset(id: string, which: "thumb" | "pdf" | number) {
    const entry = await this.get(id);
    const path =
      which === "thumb"
        ? entry.thumb
        : which === "pdf"
          ? entry.info.pdf
            ? join(entry.dir, "preview", "sample.pdf")
            : null
          : which >= 1 && which <= entry.info.pages
            ? join(entry.dir, "preview", `page-${which}.png`)
            : null;
    return path ?? fail(404, "没有这个预览");
  }

  /** May this member change or delete the template? */
  private editable(entry: Entry, user: { id: string; admin: boolean }) {
    if (entry.root.origin !== "library") fail(403, "内置模板不能修改");
    if (!user.admin && (entry.info.origin === "official" || entry.info.author?.id !== user.id))
      fail(403, "只有模板的发布者或管理员可以修改");
  }
  /** A member's project as a new template in the library; its preview is built afterwards. */
  async publish(
    input: TemplateInput,
    files: TemplateFile[],
    options: { main: string; engine: Engine; author: { id: string; name: string } },
  ) {
    const root = this.libraryRoot() ?? fail(503, "服务器没有配置模板库");
    if (!(await stat(root.dir).catch(() => null))) fail(503, "模板所在的磁盘暂时不可用");
    if (!files.some((f) => f.path === options.main))
      fail(400, "项目中没有 {main}", { main: options.main });
    const bytes = files.reduce((n, f) => n + f.data.length, 0);
    if (files.length > TEMPLATE_FILES || bytes > TEMPLATE_BYTES)
      fail(413, "模板最多 {count} 个文件、100 MB", { count: TEMPLATE_FILES });
    const slug = (input.name.en || input.venue || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const id = `${slug || "template"}-${randomBytes(3).toString("hex")}`;
    const dir = join(root.dir, id),
      partial = `${dir}.partial`;
    await rm(partial, { recursive: true, force: true });
    for (const f of files) {
      const target = join(partial, "files", ...f.path.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, f.data);
    }
    const meta: TemplateMeta = {
      ...input,
      main: options.main,
      engine: options.engine,
      order: 1000,
      venues: [],
      official: false,
      author: options.author,
      updated: Date.now(),
      fileCount: files.length,
      bytes,
      preview: { status: "pending", pages: 0, log: null },
    };
    await writeJson(join(partial, META), meta);
    await rename(partial, dir);
    this.refresh();
    void this.render(id);
    return (await this.get(id)).info;
  }
  async update(id: string, input: TemplateInput, user: { id: string; admin: boolean }) {
    const entry = await this.get(id);
    this.editable(entry, user);
    await writeJson(join(entry.dir, META), { ...entry.meta, ...input, updated: Date.now() });
    this.refresh();
    return (await this.get(id)).info;
  }
  async remove(id: string, user: { id: string; admin: boolean }) {
    const entry = await this.get(id);
    this.editable(entry, user);
    // Out of the listing at once; the files go after.
    const gone = `${entry.dir}.deleted-${Date.now()}`;
    await rename(entry.dir, gone);
    this.refresh();
    await rm(gone, { recursive: true, force: true });
  }
  /** Builds the preview again (one template at a time across the server). */
  async rebuild(id: string, user: { id: string; admin: boolean }) {
    const entry = await this.get(id);
    this.editable(entry, user);
    await writeJson(join(entry.dir, META), {
      ...entry.meta,
      preview: { ...entry.meta.preview, status: "pending" },
    });
    this.refresh();
    void this.render(id);
  }
  private render(id: string) {
    const job = this.rendering.then(async () => {
      const entry = await this.get(id).catch(() => null);
      if (!entry) return;
      const result = await renderPreview(
        entry.dir,
        entry.files,
        entry.info.main,
        entry.info.engine,
        this.options.render ?? {},
      ).catch((error) => ({ status: "failed" as const, pages: 0, log: String(error) }));
      const current = await readFile(join(entry.dir, META), "utf8")
        .then((t) => JSON.parse(t) as TemplateMeta)
        .catch(() => null);
      if (!current) return;
      await writeJson(join(entry.dir, META), {
        ...current,
        preview: { status: result.status, pages: result.pages, log: result.log },
      });
      this.refresh();
    });
    this.rendering = job.catch(() => {});
    return job;
  }
  /** Waits for previews being built (tests, shutdown). */
  idle() {
    return this.rendering;
  }
}
