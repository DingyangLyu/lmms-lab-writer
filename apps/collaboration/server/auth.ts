import { randomBytes, scrypt as rawScrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { digest, fail, type Store, type User, uid } from "./store";
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
export function userFor(store: Store, req: IncomingMessage): User {
  const token = cookie(req);
  if (!/^[a-f0-9]{64}$/.test(token)) fail(401, "请登录");
  return (
    store.get<User>(
      "SELECT u.* FROM users u JOIN sessions s ON s.user=u.id WHERE s.token=? AND s.expires>?",
      digest(token),
      Date.now(),
    ) ?? fail(401, "登录已过期")
  );
}
export function session(store: Store, user: User, res: ServerResponse, secure: boolean) {
  const token = randomBytes(32).toString("hex");
  store.run("DELETE FROM sessions WHERE expires<?", Date.now());
  store.run(
    "INSERT INTO sessions VALUES(?,?,?)",
    digest(token),
    user.id,
    Date.now() + 7 * 86400000,
  );
  res.setHeader(
    "Set-Cookie",
    `writer_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? "; Secure" : ""}`,
  );
}
export async function bootstrap(store: Store, name: string, password: string) {
  if (store.get("SELECT id FROM users LIMIT 1")) return;
  if (!name || !password)
    throw new Error("首次运行需设置 WRITER_ADMIN_USER 和 WRITER_ADMIN_PASSWORD（至少 12 位）");
  store.run("INSERT INTO users VALUES(?,?,?,1)", uid(), name, await passwordHash(password));
}
