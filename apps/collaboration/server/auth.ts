import { randomBytes, scrypt as rawScrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sql } from "./db";
import type { Store, User } from "./store";
import { digest, fail, uid } from "./util";
export function allowedOrigin(received: string | undefined, configured: string) {
  if (received === configured) return true;
  try {
    const a = new URL(received || ""),
      b = new URL(configured);
    return (
      a.protocol === "http:" &&
      b.protocol === "http:" &&
      a.port === b.port &&
      ["localhost", "127.0.0.1", "[::1]"].includes(a.hostname) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(b.hostname)
    );
  } catch {
    return false;
  }
}

const scrypt = (value: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    rawScrypt(value, salt, 64, (error, key) => (error ? reject(error) : resolve(key))),
  );
export async function passwordHash(password: string) {
  if (password.length < 12 || password.length > 200) fail(400, "密码需要 12–200 个字符");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await scrypt(password, salt)).toString("hex")}`;
}
export async function verifyPassword(value: string, saved: string) {
  const [salt, hash] = saved.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex"),
    actual = await scrypt(value, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function cookie(req: IncomingMessage) {
  return (
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("writer_session="))
      ?.slice(15) ?? ""
  );
}
/** `Authorization: Bearer <token>` from the desktop app; browsers send the session cookie. */
export function bearer(req: IncomingMessage) {
  return /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
}
/** Device tokens stay valid while used at least every 90 days. */
const DEVICE_LIFETIME = 90 * 86400000;
export async function userFor(store: Store, req: IncomingMessage): Promise<User> {
  const token = bearer(req) ?? cookie(req);
  if (!/^[a-f0-9]{64}$/.test(token)) fail(401, "请登录");
  const now = Date.now();
  const row =
    (await store.db.row<User & { device: boolean; used: number | null }>(
      sql`SELECT u.id, u.username, u.password, u.admin, u.must_change AS "mustChange",
                 s.name IS NOT NULL AS device, s.used
          FROM users u JOIN sessions s ON s.user_id=u.id
          WHERE s.token=${digest(token)} AND s.expires>${now} AND NOT u.disabled`,
    )) ?? fail(401, "登录已过期");
  if (row.device && now - (row.used ?? 0) > 3600000)
    await store.db.run(
      sql`UPDATE sessions SET used=${now}, expires=${now + DEVICE_LIFETIME} WHERE token=${digest(token)}`,
    );
  const { device: _device, used: _used, ...user } = row;
  return user;
}
/** A named token for one device; returned once, stored only as a digest. */
export async function deviceToken(store: Store, user: User, name: string) {
  const token = randomBytes(32).toString("hex"),
    now = Date.now();
  await store.db.run(
    sql`INSERT INTO sessions(token, user_id, expires, name, created, used)
        VALUES(${digest(token)}, ${user.id}, ${now + DEVICE_LIFETIME}, ${name}, ${now}, ${now})`,
  );
  return token;
}
export async function session(store: Store, user: User, res: ServerResponse, secure: boolean) {
  const token = randomBytes(32).toString("hex");
  await store.db.run(sql`DELETE FROM sessions WHERE expires<${Date.now()}`);
  await store.db.run(
    sql`INSERT INTO sessions(token, user_id, expires) VALUES(${digest(token)}, ${user.id}, ${Date.now() + 7 * 86400000})`,
  );
  res.setHeader(
    "Set-Cookie",
    `writer_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? "; Secure" : ""}`,
  );
}
/** Readable one-time password handed out by an administrator (16 characters). */
export const temporaryPassword = () => randomBytes(12).toString("base64url");
export async function bootstrap(store: Store, name: string, password: string) {
  if (await store.db.row(sql`SELECT id FROM users LIMIT 1`)) return;
  if (!name || !password)
    throw new Error("首次运行需设置 WRITER_ADMIN_USER 和 WRITER_ADMIN_PASSWORD（至少 12 位）");
  await store.db.run(
    sql`INSERT INTO users(id, username, password, admin, created)
        VALUES(${uid()}, ${name}, ${await passwordHash(password)}, true, ${Date.now()})`,
  );
}
