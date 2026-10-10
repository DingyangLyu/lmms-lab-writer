import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileInfo, TemplateDetail, TemplateInfo, TemplateList } from "../shared/api";
import { buildTemplate, decodeLegacy, glob, type Source, unpackKit } from "./template-build";
import { fixture } from "./test-fixture";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "writer-templates-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
/** Stand-ins for latexmk (a one-page PDF unless the source says FAIL) and Ghostscript. */
async function fakeTools() {
  const latexmk = join(dir, "latexmk"),
    gs = join(dir, "gs");
  await writeFile(
    latexmk,
    `#!/bin/sh
for a; do main="$a"; done
grep -q FAIL "$main" && { echo "! Undefined control sequence."; exit 12; }
mkdir -p build-output
printf '%%PDF-1.4 sample\\n' > "build-output/$(basename "$main" .tex).pdf"
`,
  );
  await writeFile(
    gs,
    `#!/bin/sh
for a; do
  case "$a" in -dLastPage=*) last="\${a#-dLastPage=}";; -sOutputFile=*) out="\${a#-sOutputFile=}";; esac
done
i=1; while [ $i -le $last ] && [ $i -le 2 ]; do printf 'PNG%s' $i > "$(printf "$out" $i)"; i=$((i+1)); done
`,
  );
  await chmod(latexmk, 0o755);
  await chmod(gs, 0o755);
  return { latexmk, gs };
}
async function libraryTemplate(root: string, id: string, meta: Record<string, unknown>) {
  await mkdir(join(root, id, "files", "figs"), { recursive: true });
  await mkdir(join(root, id, "preview"), { recursive: true });
  await writeFile(join(root, id, "files", "paper.tex"), "\\documentclass{article}");
  await writeFile(join(root, id, "files", "figs", "a.png"), new Uint8Array([1, 2, 3]));
  await writeFile(join(root, id, "preview", "page-1.png"), "PNG1");
  await writeFile(join(root, id, "preview", "thumb.png"), "THUMB");
  await writeFile(join(root, id, "preview", "sample.pdf"), "%PDF-1.4");
  await writeFile(
    join(root, id, "template.json"),
    JSON.stringify({ main: "paper.tex", official: true, ...meta }),
  );
}
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 50));
};

describe.skipIf(process.platform === "win32")("template library", () => {
  it("lists built-in and library templates with previews, and creates projects from them", async () => {
    const library = join(dir, "lib-list");
    await libraryTemplate(library, "neurips-2026", {
      name: { zh: "NeurIPS 2026", en: "NeurIPS 2026" },
      category: "conference",
      venue: "NeurIPS",
      year: 2026,
      fields: ["ml"],
      order: 10,
    });
    await mkdir(join(library, "broken"), { recursive: true });
    await writeFile(join(library, "broken", "template.json"), "{");
    const f = await fixture({ templateLibrary: library });
    const list = (await f.call("/templates", undefined, f.owner)).data as TemplateList;
    expect(list.library).toEqual({ available: true, writable: true });
    const ids = list.templates.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["blank", "article", "neurips-2026"]));
    expect(ids).not.toContain("broken");
    const neurips = list.templates.find((t) => t.id === "neurips-2026") as TemplateInfo;
    expect(neurips).toMatchObject({
      venue: "NeurIPS",
      year: 2026,
      origin: "official",
      pages: 1,
      pdf: true,
      preview: true,
      fileCount: 2,
      previewStatus: "ready",
    });
    expect(list.templates.find((t) => t.id === "article")?.origin).toBe("builtin");

    const detail = (await f.call("/templates/neurips-2026", undefined, f.owner))
      .data as TemplateDetail;
    expect(detail.files).toEqual([
      { path: "figs/a.png", bytes: 3 },
      { path: "paper.tex", bytes: 23 },
    ]);
    const get = (path: string) =>
      fetch(`${f.app.origin}/api${path}`, { headers: { Cookie: f.owner } });
    expect(await (await get("/templates/neurips-2026/preview")).text()).toBe("THUMB");
    expect(await (await get("/templates/neurips-2026/pages/1")).text()).toBe("PNG1");
    expect((await get("/templates/neurips-2026/pages/2")).status).toBe(404);
    const pdf = await get("/templates/neurips-2026/pdf");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect((await get("/templates/article/preview")).status).toBe(200);
    expect((await fetch(`${f.app.origin}/api/templates`)).status).toBe(401);

    const project = await f.call(
      "/projects",
      { name: "My NeurIPS paper", template: "neurips-2026" },
      f.owner,
    );
    expect(project.status).toBe(201);
    const files = (await f.call(`/projects/${project.data.id}/files`, undefined, f.owner))
      .data as FileInfo[];
    expect(files.map((x) => [x.path, x.binary])).toEqual([
      ["figs/a.png", true],
      ["paper.tex", false],
    ]);

    // The library's disk is unplugged: its templates go, the built-ins stay.
    await rm(library, { recursive: true, force: true });
    f.app.templates.refresh();
    const without = (await f.call("/templates", undefined, f.owner)).data as TemplateList;
    expect(without.library.available).toBe(false);
    expect(without.templates.map((t) => t.id)).not.toContain("neurips-2026");
    expect(without.templates.map((t) => t.id)).toContain("blank");
  });

  it("publishes a project as a template, builds its preview, and lets only its author or an admin change it", async () => {
    const tools = await fakeTools();
    const library = join(dir, "lib-publish");
    await mkdir(library, { recursive: true });
    await libraryTemplate(library, "official-kit", { name: { zh: "官方", en: "Official" } });
    const f = await fixture({
      templateLibrary: library,
      compile: { latexmk: tools.latexmk, timeoutMs: 20_000 },
      ghostscript: tools.gs,
    });
    const editor = await f.invite("editor", "erin");
    await f.call(
      `/projects/${f.project}/files`,
      { path: "main.tex", content: "\\documentclass{article}" },
      f.owner,
    );
    await f.call(`/projects/${f.project}/files`, { path: "fig.png", base64: "AQID" }, f.owner);
    const input = {
      name: { zh: "组会报告", en: "Group report" },
      description: { zh: "我们组的格式", en: "" },
      category: "paper",
      fields: ["ml"],
      tags: ["lab"],
      venue: null,
      year: null,
      main: "main.tex",
      engine: "pdflatex",
    };
    expect(
      (await f.call(`/projects/${f.project}/template`, { ...input, main: "nope.tex" }, editor))
        .status,
    ).toBe(400);
    expect(
      (await f.call(`/projects/${f.project}/template`, { ...input, category: "x" }, editor)).status,
    ).toBe(400);
    const published = await f.call(`/projects/${f.project}/template`, input, editor);
    expect(published.status).toBe(201);
    const id = published.data.id as string;
    expect(id).toMatch(/^group-report-[0-9a-f]{6}$/);
    expect(published.data).toMatchObject({
      origin: "member",
      author: { name: "erin" },
      previewStatus: "pending",
      description: { zh: "我们组的格式", en: "我们组的格式" },
    });
    await f.app.templates.idle();
    const ready = (await f.call(`/templates/${id}`, undefined, f.owner)).data as TemplateDetail;
    expect(ready).toMatchObject({ previewStatus: "ready", pages: 2, pdf: true, preview: true });
    expect(ready.files.map((x) => x.path)).toEqual(["fig.png", "main.tex"]);
    expect(await readFile(join(library, id, "preview", "thumb.png"), "utf8")).toBe("PNG1");

    // Another member cannot change or delete it; the author and administrators can.
    const other = await f.invite("editor", "frank");
    const update = { ...input, name: { zh: "组会报告 v2", en: "Group report v2" } };
    expect((await f.call(`/templates/${id}`, update, other, "PATCH")).status).toBe(403);
    expect((await f.call(`/templates/${id}`, update, editor, "PATCH")).data.name.zh).toBe(
      "组会报告 v2",
    );
    expect((await f.call("/templates/official-kit", {}, editor, "DELETE")).status).toBe(403);
    expect((await f.call("/templates/article", {}, f.owner, "DELETE")).status).toBe(403);
    expect((await f.call(`/templates/${id}`, {}, other, "DELETE")).status).toBe(403);

    // A source TeX cannot build keeps the template, with the log for its author.
    await f.call(`/projects/${f.project}/files`, { path: "bad.tex", content: "FAIL" }, f.owner);
    const broken = await f.call(
      `/projects/${f.project}/template`,
      { ...input, main: "bad.tex" },
      editor,
    );
    await f.app.templates.idle();
    const failed = (await f.call(`/templates/${broken.data.id}`, undefined, editor))
      .data as TemplateDetail;
    expect(failed.previewStatus).toBe("failed");
    expect(failed.previewLog).toContain("Undefined control sequence");

    expect((await f.call(`/templates/${id}`, {}, f.owner, "DELETE")).status).toBe(200);
    expect((await f.call(`/templates/${id}`, undefined, f.owner)).status).toBe(404);
    await until(async () => !(await stat(join(library, id)).catch(() => null)));
    expect(await stat(join(library, id)).catch(() => null)).toBeNull();
  });
});

describe("official template kits", () => {
  it("matches globs as the manifest writes them", () => {
    expect(glob("*.pdf").test("a.pdf")).toBe(true);
    expect(glob("*.pdf").test("figs/a.pdf")).toBe(false);
    expect(glob("Word/**").test("Word/x/y.docx")).toBe(true);
    expect(glob("**/.git*").test("a/.gitignore")).toBe(true);
    expect(glob("**/.git*").test(".gitignore")).toBe(true);
  });

  it("reads 8-bit kits as MacRoman or Windows-1252, whichever fits", () => {
    // “Radio noise” — written on a Mac (IEEE RAS's sample); “quoted” and Müller from Windows.
    expect(
      decodeLegacy(new Uint8Array([0xd2, 0x52, 0x61, 0x64, 0x69, 0x6f, 0xd3, 0x20, 0xd1])),
    ).toBe("“Radio” —");
    expect(decodeLegacy(new Uint8Array([0x93, 0x71, 0x75, 0x6f, 0x74, 0x65, 0x94]))).toBe(
      "“quote”",
    );
    expect(decodeLegacy(new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]))).toBe("Müller");
  });

  it("unpacks a kit's single top folder and builds it into the library", async () => {
    const source: Source = {
      id: "demo-2026",
      url: "https://example.invalid/demo.zip",
      archive: "demo.zip",
      exclude: ["*.pdf", "Word/**"],
      rename: { "sample.tex": "main.tex" },
      main: "main.tex",
      meta: { name: { zh: "Demo", en: "Demo" }, category: "conference", venue: "Demo", year: 2026 },
    };
    const zip = zipSync({
      // "Müller" in Latin-1, as some kits still ship their samples.
      "kit/sample.tex": new Uint8Array([
        ...strToU8("\\documentclass{article} M"),
        0xfc,
        ...strToU8("ller"),
      ]),
      "kit/demo.sty": strToU8("% style"),
      "kit/example.pdf": strToU8("%PDF"),
      "kit/Word/demo.docx": strToU8("doc"),
      "kit/.github/workflows/x.yml": strToU8("x"),
      "__MACOSX/kit/._sample.tex": strToU8("x"),
    });
    expect([...unpackKit(zip, source).keys()].sort()).toEqual([
      "Word/demo.docx",
      "demo.sty",
      "example.pdf",
      "sample.tex",
    ]);
    const cache = join(dir, "cache"),
      out = join(dir, "built");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "demo.zip"), zip);
    const built = await buildTemplate(source, { out, cache, render: false });
    expect(built).toMatchObject({ id: "demo-2026", files: 2 });
    const meta = JSON.parse(await readFile(join(out, "demo-2026", "template.json"), "utf8"));
    expect(meta).toMatchObject({ main: "main.tex", official: true, venue: "Demo", fileCount: 2 });
    expect(await readFile(join(out, "demo-2026", "files", "demo.sty"), "utf8")).toBe("% style");
    expect(await readFile(join(out, "demo-2026", "files", "main.tex"), "utf8")).toBe(
      "\\documentclass{article} Müller",
    );
    // Building again replaces the template in place.
    await buildTemplate(source, { out, cache, render: false });
    expect(await stat(join(out, "demo-2026.old")).catch(() => null)).toBeNull();
    await expect(
      buildTemplate({ ...source, main: "missing.tex" }, { out, cache, render: false }),
    ).rejects.toThrow("missing.tex");
  });
});
