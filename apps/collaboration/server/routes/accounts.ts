/** Own password changes and administrator account management for lab deployments. */
import { randomBytes } from "node:crypto";
import type { Account, IssuedPassword, IssuedSignupInvite, SignupInvite } from "../../shared/api";
import { passwordHash, session, temporaryPassword, verifyPassword } from "../auth";
import { sql, uniqueViolation } from "../db";
import { type Authed, route } from "../http";
import { registrationMode, registrationModes, setRegistrationMode } from "../registration";
import { digest, fail, uid } from "../util";

export const validUsername = (name: string) => /^[\p{L}\p{N}_ .-]{2,80}$/u.test(name);
const admin = (ctx: Authed) => {
  if (!ctx.user.admin) fail(403, "需要管理员权限");
};
const account = async (ctx: Authed, id: string) =>
  (await ctx.store.db.row<{ id: string; admin: boolean; disabled: boolean; pending: boolean }>(
    sql`SELECT id, admin, disabled, pending FROM users WHERE id=${id} AND NOT deleted`,
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
      sql`SELECT u.id, u.username, u.admin, u.disabled, u.must_change AS "mustChange", u.pending,
                 u.note, u.created,
                 (SELECT count(*) FROM members m WHERE m.user_id=u.id) AS projects,
                 (SELECT count(*) FROM members m WHERE m.user_id=u.id AND m.role='owner'
                    AND NOT EXISTS (SELECT 1 FROM members o WHERE o.project=m.project
                      AND o.role='owner' AND o.user_id<>u.id)) AS "soleOwned"
          FROM users u WHERE NOT u.deleted ORDER BY u.pending DESC, u.username`,
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
  route<Authed>("GET", /^\/api\/admin\/summary$/, async (ctx) => {
    admin(ctx);
    const row = await ctx.store.db.row<{ n: number }>(
      sql`SELECT count(*) AS n FROM users WHERE pending AND NOT deleted`,
    );
    return { pending: Number(row?.n ?? 0) };
  }),
  route<Authed>("POST", /^\/api\/admin\/users\/([^/]+)\/approve$/, async (ctx, [id = ""]) => {
    admin(ctx);
    const approved = await ctx.store.db.run(
      sql`UPDATE users SET pending=false WHERE id=${id} AND pending AND NOT deleted`,
    );
    if (!approved) fail(409, "该用户不在待审核状态");
    return { ok: true };
  }),
  /** A pending registration is removed outright; it has never written anything. */
  route<Authed>("POST", /^\/api\/admin\/users\/([^/]+)\/reject$/, async (ctx, [id = ""]) => {
    admin(ctx);
    const removed = await ctx.store.db.run(sql`DELETE FROM users WHERE id=${id} AND pending`);
    if (!removed) fail(409, "该用户不在待审核状态");
    return { ok: true };
  }),
  /**
   * Deletes (注销) an account. Its comments and versions keep their history, so the row stays
   * under a freed name; projects it owns alone pass to the deleting administrator.
   */
  route<Authed>("DELETE", /^\/api\/admin\/users\/([^/]+)$/, async (ctx, [id = ""]) => {
    admin(ctx);
    if (id === ctx.user.id) fail(400, "不能注销自己的账号");
    await account(ctx, id);
    const transfer = (await ctx.body()).transfer === true;
    const scrambled = await passwordHash(randomBytes(24).toString("hex"));
    const touched = await ctx.store.db.transaction(async (tx) => {
      const memberOf = await tx.rows<{ project: string }>(
        sql`SELECT project FROM members WHERE user_id=${id}`,
      );
      const sole = await tx.rows<{ project: string }>(
        sql`SELECT m.project FROM members m WHERE m.user_id=${id} AND m.role='owner'
            AND NOT EXISTS (SELECT 1 FROM members o WHERE o.project=m.project
              AND o.role='owner' AND o.user_id<>${id})`,
      );
      if (sole.length && !transfer)
        fail(409, "该用户是 {count} 个项目的唯一所有者，确认后这些项目会转给你", {
          count: sole.length,
        });
      for (const { project } of sole) {
        await tx.run(
          sql`INSERT INTO members(project, user_id, role) VALUES(${project}, ${ctx.user.id}, 'owner')
              ON CONFLICT (project, user_id) DO UPDATE SET role='owner'`,
        );
        await ctx.store.audit(project, ctx.user.id, "member.transfer", { from: id }, tx);
      }
      await tx.run(sql`DELETE FROM members WHERE user_id=${id}`);
      await tx.run(sql`DELETE FROM sessions WHERE user_id=${id}`);
      // ":" never passes validUsername, so no one can register (and block) a deleted name.
      await tx.run(
        sql`UPDATE users SET deleted=true, disabled=true, admin=false, pending=false, note='',
              username=${`已注销:${id}`}, password=${scrambled}
            WHERE id=${id}`,
      );
      const active = await tx.row<{ n: number }>(
        sql`SELECT count(*) AS n FROM users WHERE admin AND NOT disabled`,
      );
      if (!active?.n) fail(409, "至少需要保留一名可用的管理员");
      return memberOf.map((m) => m.project);
    });
    ctx.collab.disconnectUser(id, "账号已注销");
    // Member lists in those projects change: the account left, or the administrator took over.
    for (const project of touched) ctx.collab.changed(project);
    return { ok: true };
  }),
  route<Authed>("GET", /^\/api\/admin\/invites$/, async (ctx): Promise<SignupInvite[]> => {
    admin(ctx);
    return ctx.store.db.rows<SignupInvite>(
      sql`SELECT i.id, i.note, i.created, i.expires, i.uses, i.used, u.username AS "createdBy"
          FROM signup_invites i LEFT JOIN users u ON u.id=i.created_by
          WHERE NOT i.revoked AND i.expires>${Date.now()} AND i.used<i.uses
          ORDER BY i.created DESC LIMIT 200`,
    );
  }),
  route<Authed>("POST", /^\/api\/admin\/invites$/, async (ctx): Promise<IssuedSignupInvite> => {
    admin(ctx);
    const b = await ctx.body();
    const days = Number(b.days ?? 7),
      uses = Number(b.uses ?? 1),
      note = typeof b.note === "string" ? b.note.trim().slice(0, 200) : "";
    if (!Number.isInteger(days) || days < 1 || days > 90) fail(400, "有效期需为 1–90 天");
    if (!Number.isInteger(uses) || uses < 1 || uses > 100) fail(400, "可用次数需为 1–100 次");
    const token = randomBytes(32).toString("hex"),
      id = uid(),
      created = Date.now(),
      expires = created + days * 86400000;
    await ctx.store.db.run(
      sql`INSERT INTO signup_invites(id, token, note, created_by, created, expires, uses)
          VALUES(${id}, ${digest(token)}, ${note}, ${ctx.user.id}, ${created}, ${expires}, ${uses})`,
    );
    return {
      id,
      token,
      url: `${ctx.linkOrigin()}/?signup=${token}`,
      note,
      created,
      expires,
      uses,
      used: 0,
      createdBy: ctx.user.username,
    };
  }),
  route<Authed>("DELETE", /^\/api\/admin\/invites\/([^/]+)$/, async (ctx, [id = ""]) => {
    admin(ctx);
    await ctx.store.db.run(sql`UPDATE signup_invites SET revoked=true WHERE id=${id}`);
    return { ok: true };
  }),
  route<Authed>("GET", /^\/api\/admin\/settings$/, async (ctx) => {
    admin(ctx);
    return { registration: await registrationMode(ctx.store.db) };
  }),
  route<Authed>("PUT", /^\/api\/admin\/settings$/, async (ctx) => {
    admin(ctx);
    const wanted = (await ctx.body()).registration;
    const mode = registrationModes.find((m) => m === wanted);
    if (!mode) fail(400, "无效的注册方式");
    await setRegistrationMode(ctx.store.db, mode);
    return { registration: mode };
  }),
];
