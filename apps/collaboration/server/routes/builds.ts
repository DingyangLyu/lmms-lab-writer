/** Server-side LaTeX builds, their PDFs and SyncTeX jumps. */
import type { Build, PdfRegion, SourceLocation } from "../../shared/api";
import { type Engine, engines } from "../compile";
import { handled, type InProject, route, str } from "../http";
import { forwardSearch, inverseSearch } from "../synctex";
import { fail } from "../util";

const query = (ctx: InProject, name: string) => {
  const value = Number(ctx.url.searchParams.get(name));
  return Number.isFinite(value) ? value : fail(400, "无效参数 {name}", { name });
};
const missing = () => fail(404, "在编译结果中找不到对应位置，请重新编译");

export const buildRoutes = [
  route<InProject>("POST", /^builds$/, async (ctx): Promise<Build> => {
    await ctx.need("comment");
    const body = await ctx.body(),
      engine = str(body, "engine", 20) as Engine;
    if (!engines.includes(engine)) fail(400, "不支持的编译器");
    const build = await ctx.compiler.compile(
      ctx.project,
      ctx.user.id,
      str(body, "main", 240),
      engine,
    );
    ctx.collab.changed(ctx.project);
    return build;
  }),
  route<InProject>(
    "GET",
    /^builds\/latest$/,
    (ctx): Promise<Build | null> => ctx.compiler.latest(ctx.project),
  ),
  route<InProject>("GET", /^builds\/([^/]+)\/pdf$/, async (ctx, [id = ""]) => {
    const pdf = await ctx.compiler.pdf(ctx.project, id);
    ctx.res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="output.pdf"',
      "Cache-Control": "private, max-age=3600",
    });
    ctx.res.end(pdf);
    return handled;
  }),
  route<InProject>(
    "GET",
    /^builds\/([^/]+)\/forward$/,
    async (ctx, [id = ""]): Promise<PdfRegion> => {
      const sync = await ctx.compiler.synctex(ctx.project, id);
      return (
        forwardSearch(sync, ctx.url.searchParams.get("file") ?? "", query(ctx, "line")) ?? missing()
      );
    },
  ),
  route<InProject>(
    "GET",
    /^builds\/([^/]+)\/inverse$/,
    async (ctx, [id = ""]): Promise<SourceLocation> => {
      const sync = await ctx.compiler.synctex(ctx.project, id);
      return inverseSearch(sync, query(ctx, "page"), query(ctx, "x"), query(ctx, "y")) ?? missing();
    },
  ),
];
