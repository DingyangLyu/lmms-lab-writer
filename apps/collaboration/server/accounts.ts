/** Own password changes and administrator account management for lab deployments. */
import type { ServerResponse } from "node:http";
import { passwordHash, session, temporaryPassword, verifyPassword } from "./auth";
import type { Collaboration } from "./collaboration";
import { sql, uniqueViolation } from "./db";
import type { Store, User } from "./store";
import { fail, uid } from "./util";

type Body = Record<string, unknown>;
export const validUsername = (name: string) => /^[\p{L}\p{N}_ .-]{2,80}$/u.test(name);

/** Returns `undefined` when the route is not an account route. */
export async function accountRoute(
  store: Store,
  collab: Collaboration,
  user: User,
  res: ServerResponse,
  path: string,
  method: string,
  body: () => Promise<Body>,
  secure: boolean,
): Promise<unknown> {
  const db = store.db;
  if (path === "/api/me/password" && method === "POST") {
    const b = await body();
    if (typeof b.current !== "string" || typeof b.next !== "string")
      fail(400, "请填写当前密码和新密码");
    if (!(await verifyPassword(b.current, user.password))) fail(403, "当前密码不正确");
    if (b.next === b.current) fail(400, "新密码不能与当前密码相同");
    const hash = await passwordHash(b.next);
    await db.transaction(async (tx) => {
      await tx.run(sql`UPDATE users SET password=${hash}, must_change=false WHERE id=${user.id}`);
      // Every other device must sign in again with the new password.
      await tx.run(sql`DELETE FROM sessions WHERE user_id=${user.id}`);
    });
    collab.disconnectUser(user.id, "密码已修改，请重新登录");
    await session(store, user, res, secure);
    return { ok: true };
  }
  if (!path.startsWith("/api/admin/")) return undefined;
  if (!user.admin) fail(403, "需要管理员权限");
  if (path === "/api/admin/users" && method === "GET")
    return db.rows(
      sql`SELECT u.id, u.username, u.admin, u.disabled, u.must_change AS "mustChange", u.created,
                 (SELECT count(*) FROM members m WHERE m.user_id=u.id) AS projects
          FROM users u ORDER BY u.username`,
    );
  if (path === "/api/admin/users" && method === "POST") {
    const b = await body();
    const username = typeof b.username === "string" ? b.username.trim() : "";
    if (!validUsername(username)) fail(400, "用户名需 2–80 个字符，只能含文字、数字、空格和 _ . -");
    const password = temporaryPassword(),
      id = uid();
    try {
      await db.run(
        sql`INSERT INTO users(id, username, password, admin, must_change, created)
            VALUES(${id}, ${username}, ${await passwordHash(password)}, ${b.admin === true}, true, ${Date.now()})`,
      );
    } catch (error) {
      if (uniqueViolation(error)) fail(409, "用户名已存在");
      throw error;
    }
    return { id, username, password };
  }
  const target = /^\/api\/admin\/users\/([^/]+)(?:\/(reset))?$/.exec(path);
  if (!target?.[1]) fail(404, "接口不存在");
  const id = target[1];
  const account =
    (await db.row<{ id: string; admin: boolean; disabled: boolean }>(
      sql`SELECT id, admin, disabled FROM users WHERE id=${id}`,
    )) ?? fail(404, "用户不存在");
  if (target[2] === "reset" && method === "POST") {
    const password = temporaryPassword();
    await db.transaction(async (tx) => {
      await tx.run(
        sql`UPDATE users SET password=${await passwordHash(password)}, must_change=true WHERE id=${id}`,
      );
      await tx.run(sql`DELETE FROM sessions WHERE user_id=${id}`);
    });
    collab.disconnectUser(id, "管理员已重置密码");
    return { password };
  }
  if (!target[2] && method === "PATCH") {
    const b = await body();
    const admin = typeof b.admin === "boolean" ? b.admin : account.admin,
      disabled = typeof b.disabled === "boolean" ? b.disabled : account.disabled;
    if (id === user.id && (!admin || disabled)) fail(400, "不能取消自己的管理员权限或停用自己");
    await db.transaction(async (tx) => {
      await tx.run(sql`UPDATE users SET admin=${admin}, disabled=${disabled} WHERE id=${id}`);
      const active = await tx.row<{ n: number }>(
        sql`SELECT count(*) AS n FROM users WHERE admin AND NOT disabled`,
      );
      if (!active?.n) fail(409, "至少需要保留一名可用的管理员");
      if (disabled) await tx.run(sql`DELETE FROM sessions WHERE user_id=${id}`);
    });
    if (disabled) collab.disconnectUser(id, "账号已停用");
    return { ok: true };
  }
  fail(405, "不支持的操作");
}
