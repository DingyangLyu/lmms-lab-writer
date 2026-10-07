/** Own password changes and administrator account management for lab deployments. */
import type { Account, IssuedPassword } from "../../shared/api";
import { passwordHash, session, temporaryPassword, verifyPassword } from "../auth";
import { sql, uniqueViolation } from "../db";
import { type Authed, route } from "../http";
import { fail, uid } from "../util";

export const validUsername = (name: string) => /^[\p{L}\p{N}_ .-]{2,80}$/u.test(name);
const admin = (ctx: Authed) => {
  if (!ctx.user.admin) fail(403, "需要管理员权限");
};
const account = async (ctx: Authed, id: string) =>
  (await ctx.store.db.row<{ id: string; admin: boolean; disabled: boolean }>(
    sql`SELECT id, admin, disabled FROM users WHERE id=${id}`,
  )) ?? fail(404, "用户不存在");

export const passwordRoute = route<Authed>("POST", /^\/api\/me\/password$/, async (ctx) => {
  const { user, store } = ctx,
    b = await ctx.body();
  if (typeof b.current !== "string" || typeof b.next !== "string")
    fail(400, "请填写当前密码和新密码");
  if (!(await verifyPassword(b.current, user.password))) fail(403, "当前密码不正确");
  if (b.next === b.current) fail(400, "新密码不能与当前密码相同");
  const hash = await passwordHash(b.next);
  await store.db.transaction(async (tx) => {
    await tx.run(sql`UPDATE users SET password=${hash}, must_change=false WHERE id=${user.id}`);
    // Every other device must sign in again with the new password.
    await tx.run(sql`DELETE FROM sessions WHERE user_id=${user.id}`);
  });
  ctx.collab.disconnectUser(user.id, "密码已修改，请重新登录");
  await session(store, user, ctx.res, ctx.secure);
  return { ok: true };
});

export const adminRoutes = [
  route<Authed>("GET", /^\/api\/admin\/users$/, async (ctx): Promise<Account[]> => {
    admin(ctx);
    return ctx.store.db.rows<Account>(
      sql`SELECT u.id, u.username, u.admin, u.disabled, u.must_change AS "mustChange", u.created,
                 (SELECT count(*) FROM members m WHERE m.user_id=u.id) AS projects
          FROM users u ORDER BY u.username`,
    );
  }),
  route<Authed>(
    "POST",
    /^\/api\/admin\/users$/,
    async (ctx): Promise<IssuedPassword & { id: string }> => {
      admin(ctx);
      const b = await ctx.body();
      const username = typeof b.username === "string" ? b.username.trim() : "";
      if (!validUsername(username))
        fail(400, "用户名需 2–80 个字符，只能含文字、数字、空格和 _ . -");
      const password = temporaryPassword(),
        id = uid();
      try {
        await ctx.store.db.run(
          sql`INSERT INTO users(id, username, password, admin, must_change, created)
            VALUES(${id}, ${username}, ${await passwordHash(password)}, ${b.admin === true}, true, ${Date.now()})`,
        );
      } catch (error) {
        if (uniqueViolation(error)) fail(409, "用户名已存在");
        throw error;
      }
      return { id, username, password };
    },
  ),
  route<Authed>(
    "POST",
    /^\/api\/admin\/users\/([^/]+)\/reset$/,
    async (ctx, [id = ""]): Promise<IssuedPassword> => {
      admin(ctx);
      await account(ctx, id);
      const password = temporaryPassword();
      await ctx.store.db.transaction(async (tx) => {
        await tx.run(
          sql`UPDATE users SET password=${await passwordHash(password)}, must_change=true WHERE id=${id}`,
        );
        await tx.run(sql`DELETE FROM sessions WHERE user_id=${id}`);
      });
      ctx.collab.disconnectUser(id, "管理员已重置密码");
      return { password };
    },
  ),
  route<Authed>("PATCH", /^\/api\/admin\/users\/([^/]+)$/, async (ctx, [id = ""]) => {
    admin(ctx);
    const current = await account(ctx, id),
      b = await ctx.body();
    const isAdmin = typeof b.admin === "boolean" ? b.admin : current.admin,
      disabled = typeof b.disabled === "boolean" ? b.disabled : current.disabled;
    if (id === ctx.user.id && (!isAdmin || disabled))
      fail(400, "不能取消自己的管理员权限或停用自己");
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(sql`UPDATE users SET admin=${isAdmin}, disabled=${disabled} WHERE id=${id}`);
      const active = await tx.row<{ n: number }>(
        sql`SELECT count(*) AS n FROM users WHERE admin AND NOT disabled`,
      );
      if (!active?.n) fail(409, "至少需要保留一名可用的管理员");
      if (disabled) await tx.run(sql`DELETE FROM sessions WHERE user_id=${id}`);
    });
    if (disabled) ctx.collab.disconnectUser(id, "账号已停用");
    return { ok: true };
  }),
];
