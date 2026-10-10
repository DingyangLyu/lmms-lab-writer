/** Request context, body parsing and a small method + path router for the HTTP API. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Collaboration } from "./collaboration";
import type { Compiler } from "./compile";
import { sizeText } from "./limits";
import type { Store, User } from "./store";
import type { TemplateLibrary } from "./templates";
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
/** Most requests; routes that carry a file allow more, after sign-in. */
const JSON_BYTES = 16_000_000;
async function readJson(req: IncomingMessage, limit: number): Promise<Body> {
  const raw = await readBody(req, limit);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    fail(400, "无效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "请求必须为 JSON 对象");
  return value as Body;
}
/**
 * The request body, at most `limit` bytes. With a Content-Length the buffer is allocated once,
 * so a large upload is not held twice while it is put together.
 */
export async function readBody(
  req: IncomingMessage,
  limit: number,
  message = "请求超过 {size}",
): Promise<Buffer> {
  const tooLarge = () => fail(413, message, { size: sizeText(limit) });
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) tooLarge();
  const whole = Number.isSafeInteger(declared) && declared >= 0 ? Buffer.alloc(declared) : null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    if (size + b.length > (whole ? whole.length : limit)) tooLarge();
    if (whole) b.copy(whole, size);
    else chunks.push(b);
    size += b.length;
  }
  if (whole && size !== whole.length) fail(400, "上传未完成");
  return whole ?? Buffer.concat(chunks);
}
export function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

/**
 * A runner the server operator shares with every project, e.g. a lab machine running Codex or
 * OpenCode with the lab's account. Its token is configured on the server, never stored.
 */
export type SharedRunner = { token: string; name: string; capabilities: string[] };
export type Services = {
  store: Store;
  collab: Collaboration;
  compiler: Compiler;
  origin: () => string;
  /** Behind a reverse proxy: take the client address from its X-Forwarded-For. */
  trustProxy: boolean;
  sharedRunner?: SharedRunner;
  /** The template gallery. */
  templates: TemplateLibrary;
};
export type Context = Services & {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  /** JSON request body, read once on first use; at most 16 MB unless a route allows more. */
  body: (limit?: number) => Promise<Body>;
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
    body: (limit = JSON_BYTES) => {
      body ??= readJson(req, limit);
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
