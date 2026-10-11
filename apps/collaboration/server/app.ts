import { readFile, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import type { Locale } from "@lmms-lab/i18n";
import { Agents } from "./agents";
import { allowedOrigin, bearer, bootstrap, userFor } from "./auth";
import { Collaboration } from "./collaboration";
import { type CompileOptions, Compiler } from "./compile";
import { sql } from "./db";
import type { SharedRunner } from "./http";
import {
  type Authed,
  type Context,
  context,
  dispatch,
  type InProject,
  json,
  Reply,
  route,
} from "./http";
import { requestLocale, say } from "./messages";
import { adminRoutes, passwordRoute } from "./routes/accounts";
import { bibliographyRoutes } from "./routes/bibliography";
import { buildRoutes } from "./routes/builds";
import { commentRoutes } from "./routes/comments";
import { downloadRoutes } from "./routes/downloads";
import { fileRoutes } from "./routes/files";
import { historyRoutes } from "./routes/history";
import { jobRoutes, runnerRoute } from "./routes/jobs";
import { addMemberRoute, peopleRoutes } from "./routes/people";
import { projectListRoutes, projectRoutes } from "./routes/projects";
import { proposalRoutes } from "./routes/proposals";
import { sessionRoutes } from "./routes/session";
import { publishTemplateRoute, templateRoutes } from "./routes/templates";
import { Store } from "./store";
import { TemplateLibrary } from "./templates";
import { fail, HttpError } from "./util";

export type Options = {
  /** `postgres://…` for production, `pglite:<dir>` or `pglite:memory` for tests and trials. */
  databaseUrl: string;
  adminUser?: string;
  adminPassword?: string;
  host?: string;
  port?: number;
  origin?: string;
  /** Set when a reverse proxy (Caddy, nginx) forwards the requests. */
  trustProxy?: boolean;
  staticDirectory?: string;
  compile?: CompileOptions;
  /** A runner the server operator shares with every project (see routes/jobs.ts). */
  sharedRunner?: SharedRunner;
  /** Extra project templates (a lab's thesis template…), added to the built-in ones. */
  templatesDirectory?: string;
  /**
   * The template library: official conference kits and members' templates, with previews. It
   * may be on a data disk; while that is missing, only the other templates are listed.
   */
  templateLibrary?: string;
  /** Ghostscript for template previews; default `rungs` beside latexmk. */
  ghostscript?: string;
  /** Desktop installers offered to members (see routes/downloads.ts). */
  downloadsDirectory?: string;
};
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; font-src 'self' data: blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};
// Module scripts and workers (pdf.js) are refused unless served as JavaScript.
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  // The spell checker's Hunspell dictionary.
  ".aff": "text/plain; charset=utf-8",
  ".dic": "text/plain; charset=utf-8",
};
/** Text worth compressing; images, fonts and PDFs are compressed already. */
const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".svg",
  ".json",
  ".map",
  ".txt",
  ".aff",
  ".dic",
]);
/** Compressed copies of the built files, made once per file version. */
const compressedCache = new Map<string, Buffer>();
const brotli = promisify(brotliCompress),
  gzipAsync = promisify(gzip);
/**
 * The web app's files. Built assets carry a hash of their content in the name, so browsers keep
 * them for good; index.html is checked every time, so a new build is picked up at once. Text is
 * sent compressed (Brotli or gzip): the editor's script is 1.4 MB, a few hundred kB compressed,
 * which matters through a tunnel to another city.
 */
async function serveStatic(ctx: Context, root: string) {
  const path = ctx.url.pathname;
  let requested = "index.html";
  if (path !== "/" && extname(path))
    try {
      requested = decodeURIComponent(path).replace(/^\//, "");
    } catch {
      fail(400, "无效路径");
    }
  const file = resolve(root, requested);
  if (!file.startsWith(`${root}${sep}`)) fail(403, "无效路径");
  const info = await stat(file).catch(() => fail(404, "资源不存在，请先运行 pnpm build"));
  if (!info.isFile()) fail(404, "资源不存在，请先运行 pnpm build");
  const type = extname(file);
  const headers: Record<string, string | number> = {
    "Content-Type": STATIC_TYPES[type] ?? "application/octet-stream",
    "Cache-Control": requested.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
  let body: Buffer = await readFile(file);
  if (COMPRESSIBLE.has(type) && body.length > 1024) {
    headers.Vary = "Accept-Encoding";
    const accepted = String(ctx.req.headers["accept-encoding"] ?? "");
    const encoding = /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : null;
    if (encoding) {
      const key = `${file}:${info.mtimeMs}:${encoding}`;
      let packed = compressedCache.get(key);
      if (!packed) {
        packed =
          encoding === "br"
            ? await brotli(body, {
                params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 },
              })
            : await gzipAsync(body, { level: 9 });
        compressedCache.set(key, packed);
      }
      headers["Content-Encoding"] = encoding;
      body = packed;
    }
  }
  headers["Content-Length"] = body.length;
  ctx.res.writeHead(200, headers);
  ctx.res.end(ctx.method === "HEAD" ? undefined : body);
}
function sendError(res: ServerResponse, error: unknown, locale: Locale) {
  const status = error instanceof HttpError ? error.status : 500;
  if (!res.headersSent)
    json(
      res,
      {
        error:
          error instanceof HttpError
            ? say(locale, error.template, error.params)
            : say(locale, "服务操作失败，数据仍保留；请检查服务日志"),
      },
      status,
    );
  if (status === 500)
    console.error("Writer request failed:", error instanceof Error ? error.message : "unknown");
}

export async function createWriterServer(options: Options) {
  const store = await Store.open(options.databaseUrl);
  try {
    await bootstrap(store, options.adminUser ?? "", options.adminPassword ?? "");
  } catch (error) {
    await store.close();
    throw error;
  }
  // WRITER_ORIGIN may list several addresses; the first is the one links are made with.
  const configured = (options.origin ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  let origin = configured[0] ?? `http://127.0.0.1:${options.port ?? 8787}`;
  const trusted = () => (configured.length ? configured : [origin]);
  const collab = new Collaboration(store, () => origin, trusted);
  const agents = new Agents(store, collab, () => origin, options.sharedRunner, trusted);
  const services = {
    store,
    collab,
    compiler: new Compiler(store, options.compile),
    origin: () => origin,
    trusted,
    trustProxy: options.trustProxy ?? false,
    sharedRunner: options.sharedRunner,
    templates: new TemplateLibrary(join(import.meta.dirname, "../templates"), {
      lab: options.templatesDirectory,
      library: options.templateLibrary,
      render: { compile: options.compile, ghostscript: options.ghostscript },
    }),
    downloads: options.downloadsDirectory ?? null,
  };
  const staticRoot = resolve(options.staticDirectory ?? join(import.meta.dirname, "../dist"));
  const session = await sessionRoutes();
  const publicRoutes = [...session.public, runnerRoute];
  /** Still reachable while an account must replace a temporary password. */
  const accountRoutes = [...session.authed, passwordRoute];
  const signedInRoutes = [
    ...adminRoutes,
    ...projectListRoutes,
    ...templateRoutes,
    ...peopleRoutes,
    ...downloadRoutes,
  ];
  const projectScoped = [
    ...projectRoutes,
    publishTemplateRoute,
    addMemberRoute,
    ...fileRoutes,
    ...bibliographyRoutes,
    ...commentRoutes,
    ...historyRoutes,
    ...proposalRoutes,
    ...buildRoutes,
    ...jobRoutes,
  ];
  // What the workbench reads on opening and after each change, in one request: separately
  // they cost an extra round trip over a slow link (a browser opens six at a time).
  projectScoped.push(
    route<InProject>("GET", /^overview$/, async (ctx) => {
      const read = async (target: string) => {
        const found = projectScoped.find((r) => r.method === "GET" && r.path.test(target));
        if (!found) return fail(404, "接口不存在");
        const params = (found.path.exec(target) ?? []).slice(1).map((p) => p ?? "");
        const result = await found.run(ctx, params);
        return result instanceof Reply ? result.body : (result ?? null);
      };
      const [files, comments, members, snapshots, proposals, latestBuild, summary] =
        await Promise.all(
          ["files", "comments", "members", "snapshots", "proposals", "builds/latest", ""].map(read),
        );
      return { files, comments, members, snapshots, proposals, latestBuild, summary };
    }),
  );
  const server = createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      const ctx = context(services, req, res),
        path = ctx.url.pathname;
      // Bearer tokens are never sent automatically by a browser, so they cannot be forged
      // cross-site; nor can a page read the token that desktop sign-in returns.
      if (
        !["GET", "HEAD"].includes(ctx.method) &&
        !bearer(req) &&
        !(ctx.method === "POST" && path === "/api/tokens") &&
        !allowedOrigin(req.headers.origin, trusted(), req.headers.host)
      )
        fail(403, "请求来源不匹配");
      if (path === "/api/health") {
        await store.db.row(sql`SELECT 1`);
        return json(res, { ok: true });
      }
      if (!path.startsWith("/api/")) return await serveStatic(ctx, staticRoot);
      if (await dispatch(publicRoutes, ctx, path)) return;
      const signedIn: Authed = { ...ctx, user: await userFor(store, req) };
      if (await dispatch(accountRoutes, signedIn, path)) return;
      if (signedIn.user.mustChange) fail(403, "请先修改管理员给你的临时密码");
      if (await dispatch(signedInRoutes, signedIn, path)) return;
      const scope = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (!scope?.[1]) fail(404, "接口不存在");
      const project = scope[1],
        user = signedIn.user.id;
      const inProject: InProject = {
        ...signedIn,
        project,
        role: await store.require(project, user),
        need: (minimum) => store.require(project, user, minimum),
      };
      if (await dispatch(projectScoped, inProject, scope[2] ?? "")) return;
      fail(404, "接口不存在");
    } catch (error) {
      sendError(res, error, requestLocale(req.headers));
    }
  });
  // A 500 MB zip over a slow link takes longer than Node's default five minutes.
  server.requestTimeout = 30 * 60_000;
  server.on("upgrade", (req, socket, head) =>
    agents.handles(req) ? agents.upgrade(req, socket, head) : collab.upgrade(req, socket, head),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", resolve);
    });
  } catch (error) {
    agents.close();
    collab.close();
    await store.close();
    throw error;
  }
  const address = server.address();
  if (!configured.length && address && typeof address !== "string")
    origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    store,
    collab,
    agents,
    templates: services.templates,
    origin,
    close: async () => {
      await services.templates.idle();
      agents.close();
      collab.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await store.close();
    },
  };
}
