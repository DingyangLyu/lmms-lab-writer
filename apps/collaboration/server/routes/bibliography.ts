/** DOI lookup, BibTeX import and project-wide citation key renames. */
import {
  importBibliography,
  normalizeDoi,
  renameBibKey,
  renameCitationKey,
} from "@lmms-lab/writing";
import type { BibliographyImport } from "../../shared/api";
import { type InProject, route, str } from "../http";
import { checked, fail } from "../util";

export const bibliographyRoutes = [
  route<InProject>("POST", /^doi$/, async (ctx) => {
    await ctx.need("edit");
    const body = await ctx.body();
    const doi = checked(() => normalizeDoi(str(body, "doi", 300)));
    const response = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}/transform/application/x-bibtex`,
      {
        signal: AbortSignal.timeout(20000),
        redirect: "error",
        headers: { "User-Agent": "Writer bibliography lookup" },
      },
    );
    if (!response.ok) fail(502, "Crossref 未找到这个 DOI");
    const data = await response.text();
    if (data.length > 100000) fail(502, "元数据过大");
    return { bibtex: data };
  }),
  route<InProject>("POST", /^bibliography\/import$/, async (ctx): Promise<BibliographyImport> => {
    await ctx.need("edit");
    const { store, collab, project } = ctx,
      body = await ctx.body(),
      file = await store.fileMeta(project, str(body, "file"));
    if (file.binary || !file.path.endsWith(".bib")) fail(400, "请选择 BibTeX 文件");
    const current = await collab.text(project, file.id);
    if (current !== str(body, "expected", 2_000_000)) fail(409, "文献库已有新的修改");
    const result = checked(() => importBibliography(current, str(body, "bibtex", 2_000_000)));
    if (result.added) {
      await store.snapshot(project, ctx.user.id, "导入文献前");
      await collab.replace(project, file.id, current, result.content, ctx.user.id);
    }
    return { added: result.added, skipped: result.skipped, renamed: result.renamed };
  }),
  route<InProject>("POST", /^bibliography\/rename$/, async (ctx) => {
    await ctx.need("edit");
    const { store, project } = ctx,
      body = await ctx.body(),
      from = str(body, "from", 150),
      to = str(body, "to", 150);
    const files = await store.textFiles(project);
    const plans = checked(() =>
      files
        .map((f) => ({
          ...f,
          next: f.path.endsWith(".bib")
            ? renameBibKey(f.content, from, to)
            : f.path.endsWith(".tex")
              ? renameCitationKey(f.content, from, to)
              : f.content,
        }))
        .filter((f) => f.content !== f.next),
    );
    if (!plans.length) return { files: 0 };
    await store.snapshot(project, ctx.user.id, "重命名文献键前");
    await ctx.collab.replaceMany(
      project,
      plans.map((p) => ({ file: p.id, expected: p.content, content: p.next })),
      ctx.user.id,
    );
    return { files: plans.length };
  }),
];
