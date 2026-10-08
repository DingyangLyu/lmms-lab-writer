/** Request context, body parsing and a small method + path router for the HTTP API. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Collaboration } from "./collaboration";
import type { Compiler } from "./compile";
import type { Store, User } from "./store";
import { type Access, fail, type Role, roles } from "./util";

export type Body = Record<string, unknown>;
export const str = (body: Body, key: string, max = 10000) =>
  typeof body[key] === "string" && body[key].length <= max
    ? (body[key] as string)
    : fail(400, "无效字段 {key}", { key });
export const number = (body: Body, key: string) =>
  typeof body[key] === "number" && Number.isSafeInteger(body[key])
    ? (body[key] as number)
    : fail(400, "无效字段 {key}", { key });
export function roleInput(value: string): Role {
  if (!roles.includes(value as Role)) fail(400, "无效角色");
  return value as Role;
}
async function readJson(req: IncomingMessage): Promise<Body> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > 16_000_000) fail(413, "请求超过 16 MB");
    chunks.push(b);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail(400, "无效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "请求必须为 JSON 对象");
  return value as Body;
}
export function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

export type Services = {
  store: Store;
  collab: Collaboration;
  compiler: Compiler;
  origin: () => string;
  /** Behind a reverse proxy: take the client address from its X-Forwarded-For. */
  trustProxy: boolean;
};
export type Context = Services & {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  /** JSON request body, read once on first use. */
  body: () => Promise<Body>;
  secure: boolean;
  /** Client address, used to rate-limit sign-in attempts. */
  ip: string;
};
export type Authed = Context & { user: User };
export type InProject = Authed & {
  project: string;
  role: Role;
  /** Throws 403 unless the member's role allows `minimum`. */
  need: (minimum: Access) => Promise<Role>;
};
/** The proxy appends the address it saw last, so earlier (client-supplied) entries are ignored. */
export function clientAddress(req: IncomingMessage, trustProxy: boolean) {
  const forwarded = trustProxy ? req.headers["x-forwarded-for"] : undefined;
  const last = [forwarded ?? []]
    .flat()
    .join(",")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  return last || req.socket.remoteAddress || "unknown";
}
export function context(services: Services, req: IncomingMessage, res: ServerResponse): Context {
  let body: Promise<Body> | null = null;
  return {
    ...services,
    req,
    res,
    url: new URL(req.url ?? "/", services.origin()),
    method: req.method ?? "GET",
    body: () => {
      body ??= readJson(req);
      return body;
    },
    secure: services.origin().startsWith("https:"),
    ip: clientAddress(req, services.trustProxy),
  };
}

/** A JSON response with a status other than 200. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
export const created = (body: unknown) => new Reply(201, body);
/** Returned by handlers that wrote the response themselves (files, PDFs). */
export const handled = Symbol("handled");

export type Route<C> = {
  method: string;
  path: RegExp;
  run: (ctx: C, params: string[]) => Promise<unknown>;
};
export const route = <C>(
  method: string,
  path: RegExp,
  run: (ctx: C, params: string[]) => Promise<unknown>,
): Route<C> => ({ method, path, run });

/** Runs the first route matching method and path; `false` when none matches. */
export async function dispatch<C extends Context>(routes: Route<C>[], ctx: C, target: string) {
  for (const r of routes) {
    if (r.method !== ctx.method) continue;
    const match = r.path.exec(target);
    if (!match) continue;
    const result = await r.run(
      ctx,
      match.slice(1).map((p) => p ?? ""),
    );
    if (result === handled) return true;
    if (result instanceof Reply) json(ctx.res, result.body, result.status);
    else json(ctx.res, result ?? { ok: true });
    return true;
  }
  return false;
}
