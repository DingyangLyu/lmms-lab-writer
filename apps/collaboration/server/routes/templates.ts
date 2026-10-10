/** The template gallery: listing, previews, publishing a project, and managing templates. */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { Engine, TemplateDetail, TemplateInfo, TemplateList } from "../../shared/api";
import { engines } from "../compile";
import { type Authed, created, handled, type InProject, route, str } from "../http";
import { templateInput } from "../templates";
import { decodeText, fail, safePath } from "../util";

/** Sends a preview file; previews change only with a new `updated`, which the page puts in the URL. */
async function send(ctx: Authed, path: string, type: string, name?: string) {
  const info = await stat(path).catch(() => fail(404, "没有这个预览"));
  ctx.res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    "Cache-Control": "private, max-age=86400",
    ...(name ? { "Content-Disposition": `inline; filename="${name}"` } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(ctx.res);
  });
  return handled;
}
const ID = "([a-z0-9][a-z0-9-]{0,63})";

export const templateRoutes = [
  route<Authed>("GET", /^\/api\/templates$/, (ctx): Promise<TemplateList> => ctx.templates.list()),
  route<Authed>(
    "GET",
    new RegExp(`^/api/templates/${ID}$`),
    (ctx, [id = ""]): Promise<TemplateDetail> => ctx.templates.detail(id),
  ),
  route<Authed>("GET", new RegExp(`^/api/templates/${ID}/preview$`), async (ctx, [id = ""]) =>
    send(ctx, await ctx.templates.asset(id, "thumb"), "image/png"),
  ),
  route<Authed>(
    "GET",
    new RegExp(`^/api/templates/${ID}/pages/(\\d{1,2})$`),
    async (ctx, [id = "", n = ""]) =>
      send(ctx, await ctx.templates.asset(id, Number(n)), "image/png"),
  ),
  route<Authed>("GET", new RegExp(`^/api/templates/${ID}/pdf$`), async (ctx, [id = ""]) =>
    send(ctx, await ctx.templates.asset(id, "pdf"), "application/pdf", `${id}.pdf`),
  ),
  route<Authed>(
    "PATCH",
    new RegExp(`^/api/templates/${ID}$`),
    async (ctx, [id = ""]): Promise<TemplateInfo> =>
      ctx.templates.update(id, templateInput(await ctx.body()), ctx.user),
  ),
  route<Authed>("DELETE", new RegExp(`^/api/templates/${ID}$`), async (ctx, [id = ""]) => {
    await ctx.templates.remove(id, ctx.user);
    return { ok: true };
  }),
  route<Authed>("POST", new RegExp(`^/api/templates/${ID}/render$`), async (ctx, [id = ""]) => {
    await ctx.templates.rebuild(id, ctx.user);
    return { ok: true };
  }),
];

/** Publishes the project's current files as a template everyone on the server can use. */
export const publishTemplateRoute = route<InProject>("POST", /^template$/, async (ctx) => {
  await ctx.need("edit");
  const body = await ctx.body();
  const input = templateInput(body);
  const main = safePath(str(body, "main", 240));
  if (!main.endsWith(".tex")) fail(400, "请选择 .tex 主文件");
  const engine = String(body.engine ?? "pdflatex") as Engine;
  if (!engines.includes(engine)) fail(400, "不支持的编译器");
  const files = (await ctx.store.projectFiles(ctx.project)).map((f) => ({
    path: f.path,
    data: f.binary ? f.state : Buffer.from(decodeText(f.state)),
  }));
  const info = await ctx.templates.publish(input, files, {
    main,
    engine,
    author: { id: ctx.user.id, name: ctx.user.username },
  });
  await ctx.store.audit(ctx.project, ctx.user.id, "template.publish", { template: info.id });
  return created(info);
});
