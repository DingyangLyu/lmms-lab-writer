import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { Locale } from "@lmms-lab/i18n";
import { allowedOrigin, bearer, bootstrap, userFor } from "./auth";
import { Collaboration } from "./collaboration";
import { type CompileOptions, Compiler } from "./compile";
import { sql } from "./db";
import type { SharedRunner } from "./http";
import { type Authed, type Context, context, dispatch, type InProject, json } from "./http";
import { requestLocale, say } from "./messages";
import { adminRoutes, passwordRoute } from "./routes/accounts";
import { bibliographyRoutes } from "./routes/bibliography";
import { buildRoutes } from "./routes/builds";
import { commentRoutes } from "./routes/comments";
import { fileRoutes } from "./routes/files";
import { historyRoutes } from "./routes/history";
import { jobRoutes, runnerRoute } from "./routes/jobs";
import { projectListRoutes, projectRoutes } from "./routes/projects";
import { proposalRoutes } from "./routes/proposals";
import { sessionRoutes } from "./routes/session";
import { Store } from "./store";
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
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};
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
  const content = await readFile(file).catch(() => fail(404, "资源不存在，请先运行 pnpm build"));
  ctx.res.writeHead(200, {
    "Content-Type": STATIC_TYPES[extname(file)] ?? "application/octet-stream",
  });
  ctx.res.end(ctx.method === "HEAD" ? undefined : content);
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
  let origin = options.origin ?? `http://127.0.0.1:${options.port ?? 8787}`;
  const collab = new Collaboration(store, () => origin);
  const services = {
    store,
    collab,
    compiler: new Compiler(store, options.compile),
    origin: () => origin,
    trustProxy: options.trustProxy ?? false,
    sharedRunner: options.sharedRunner,
  };
  const staticRoot = resolve(options.staticDirectory ?? join(import.meta.dirname, "../dist"));
  const session = await sessionRoutes();
  const publicRoutes = [...session.public, runnerRoute];
  /** Still reachable while an account must replace a temporary password. */
  const accountRoutes = [...session.authed, passwordRoute];
  const signedInRoutes = [...adminRoutes, ...projectListRoutes];
  const projectScoped = [
    ...projectRoutes,
    ...fileRoutes,
    ...bibliographyRoutes,
    ...commentRoutes,
    ...historyRoutes,
    ...proposalRoutes,
    ...buildRoutes,
    ...jobRoutes,
  ];
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
        !allowedOrigin(req.headers.origin, origin)
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
  server.on("upgrade", (req, socket, head) => collab.upgrade(req, socket, head));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", resolve);
    });
  } catch (error) {
    collab.close();
    await store.close();
    throw error;
  }
  const address = server.address();
  if (!options.origin && address && typeof address !== "string")
    origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    store,
    collab,
    origin,
    close: async () => {
      collab.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await store.close();
    },
  };
}
