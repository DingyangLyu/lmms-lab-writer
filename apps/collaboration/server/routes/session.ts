/** Sign-in, invitations and the current session. */
import { randomBytes } from "node:crypto";
import type { Device, IssuedToken, PublicUser } from "../../shared/api";
import { bearer, cookie, deviceToken, passwordHash, session, verifyPassword } from "../auth";
import { sql, uniqueViolation } from "../db";
import { type Authed, type Context, route, str } from "../http";
import { type User, userColumns } from "../store";
import { digest, fail, type Role, uid } from "../util";
import { validUsername } from "./accounts";

export const publicUser = (u: User): PublicUser => ({
  id: u.id,
  name: u.username,
  admin: !!u.admin,
  mustChange: !!u.mustChange,
});

export async function sessionRoutes() {
  const attempts = new Map<string, { at: number; count: number }>();
  // Unknown usernames still pay the scrypt cost, so login timing does not reveal accounts.
  const decoy = await passwordHash(randomBytes(16).toString("hex"));
  const limit = (ctx: Context) => {
    const ip = ctx.ip,
      old = attempts.get(ip),
      attempt = old && Date.now() - old.at < 60000 ? old : { at: Date.now(), count: 0 };
    attempts.set(ip, attempt);
    if (++attempt.count > 12) fail(429, "登录尝试过多，请稍后重试");
    if (attempts.size > 1000)
      for (const [key, a] of attempts) if (Date.now() - a.at > 60000) attempts.delete(key);
  };
  const byName = (ctx: Context, username: string) =>
    ctx.store.db.row<User & { disabled: boolean }>({
      text: `SELECT ${userColumns}, disabled FROM users WHERE username=$1`,
      values: [username],
    });
  const signIn = async (ctx: Context) => {
    limit(ctx);
    const body = await ctx.body(),
      username = str(body, "username", 80),
      password = str(body, "password", 200);
    const user = await byName(ctx, username);
    const valid = await verifyPassword(password, user?.password ?? decoy);
    if (!user || !valid) fail(401, "用户名或密码错误");
    if (user.disabled) fail(403, "账号已停用，请联系管理员");
    return user;
  };
  return {
    public: [
      route<Context>("POST", /^\/api\/login$/, async (ctx) => {
        const user = await signIn(ctx);
        await session(ctx.store, user, ctx.res, ctx.secure);
        return publicUser(user);
      }),
      /** Desktop sign-in: a named device token instead of a browser cookie. */
      route<Context>("POST", /^\/api\/tokens$/, async (ctx): Promise<IssuedToken> => {
        const user = await signIn(ctx);
        if (user.mustChange) fail(403, "请先在网页上修改管理员给你的临时密码");
        const name = str(await ctx.body(), "name", 80).trim() || "Writer Desktop";
        return { token: await deviceToken(ctx.store, user, name), user: publicUser(user) };
      }),
      route<Context>("POST", /^\/api\/join$/, async (ctx) => {
        limit(ctx);
        const { store } = ctx,
          db = store.db;
        const body = await ctx.body(),
          token = str(body, "token", 100),
          username = str(body, "username", 80),
          password = str(body, "password", 200);
        if (!validUsername(username)) fail(400, "用户名格式无效");
        const invitation = await db.row<{
          project: string;
          role: Role;
          expires: number;
          used: boolean;
        }>(sql`SELECT project, role, expires, used FROM invites WHERE token=${digest(token)}`);
        if (!invitation || invitation.used || invitation.expires < Date.now())
          fail(410, "邀请已失效");
        const existing = await byName(ctx, username);
        if (existing && !(await verifyPassword(password, existing.password)))
          fail(401, "该用户名已存在，请使用原密码");
        if (existing?.disabled) fail(403, "账号已停用，请联系管理员");
        const user: User = existing ?? {
          id: uid(),
          username,
          password: await passwordHash(password),
          admin: false,
          mustChange: false,
        };
        try {
          await db.transaction(async (tx) => {
            const claimed = await tx.run(
              sql`UPDATE invites SET used=true WHERE token=${digest(token)} AND NOT used AND expires>${Date.now()}`,
            );
            if (!claimed) fail(410, "邀请已使用");
            if (!existing)
              await tx.run(
                sql`INSERT INTO users(id, username, password, admin, created)
                    VALUES(${user.id}, ${username}, ${user.password}, false, ${Date.now()})`,
              );
            await tx.run(
              sql`INSERT INTO members(project, user_id, role) VALUES(${invitation.project}, ${user.id}, ${invitation.role})
                  ON CONFLICT (project, user_id) DO NOTHING`,
            );
            await store.audit(invitation.project, user.id, "member.join", {}, tx);
          });
        } catch (error) {
          if (uniqueViolation(error)) fail(409, "该用户名刚被注册，请换一个");
          throw error;
        }
        await session(store, user, ctx.res, ctx.secure);
        return publicUser(user);
      }),
    ],
    /** Allowed even while the account must still replace a temporary password. */
    authed: [
      route<Authed>("GET", /^\/api\/me$/, async (ctx) => publicUser(ctx.user)),
      route<Authed>("POST", /^\/api\/logout$/, async (ctx) => {
        await ctx.store.db.run(sql`DELETE FROM sessions WHERE token=${digest(cookie(ctx.req))}`);
        ctx.res.setHeader(
          "Set-Cookie",
          "writer_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        ctx.collab.disconnectUser(ctx.user.id, "已退出登录");
        return { ok: true };
      }),
      route<Authed>("GET", /^\/api\/tokens$/, (ctx) =>
        ctx.store.db.rows<Device>(
          sql`SELECT left(token, 16) AS id, name, created, used FROM sessions
              WHERE user_id=${ctx.user.id} AND name IS NOT NULL AND expires>${Date.now()}
              ORDER BY created`,
        ),
      ),
      /** `current` signs this device out; an id signs out another of the user's devices. */
      route<Authed>("DELETE", /^\/api\/tokens\/([a-f0-9]{16}|current)$/, async (ctx, [id = ""]) => {
        const own = bearer(ctx.req);
        if (id === "current") {
          if (!own) fail(400, "当前不是设备登录");
          await ctx.store.db.run(sql`DELETE FROM sessions WHERE token=${digest(own)}`);
        } else
          await ctx.store.db.run(
            sql`DELETE FROM sessions WHERE user_id=${ctx.user.id} AND name IS NOT NULL AND left(token, 16)=${id}`,
          );
        return { ok: true };
      }),
    ],
  };
}
