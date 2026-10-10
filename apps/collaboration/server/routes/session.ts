/** Sign-in, invitations and the current session. */
import { randomBytes } from "node:crypto";
import type { Device, IssuedToken, PublicUser, Registered } from "../../shared/api";
import { bearer, cookie, deviceToken, passwordHash, session, verifyPassword } from "../auth";
import { sql, uniqueViolation } from "../db";
import { type Authed, type Context, route, str } from "../http";
import { registrationMode, usableInvite } from "../registration";
import { type User, userColumns } from "../store";
import { digest, fail, type Role, uid } from "../util";
import { validUsername } from "./accounts";

export const publicUser = (u: User): PublicUser => ({
  id: u.id,
  name: u.username,
  admin: !!u.admin,
  mustChange: !!u.mustChange,
  avatar: u.avatar === null || u.avatar === undefined ? null : Number(u.avatar),
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
    ctx.store.db.row<User & { disabled: boolean; pending: boolean }>({
      text: `SELECT ${userColumns}, disabled, pending FROM users WHERE username=$1 AND NOT deleted`,
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
    if (user.pending) fail(403, "账号正在等待管理员审核");
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
      /** What the sign-in page offers; `?invite=` checks a site invitation. */
      route<Context>("GET", /^\/api\/registration$/, async (ctx) => {
        const invite = ctx.url.searchParams.get("invite");
        return {
          mode: await registrationMode(ctx.store.db),
          invite: invite ? !!(await ctx.store.db.row(usableInvite(digest(invite)))) : false,
        };
      }),
      /** Self-registration: active at once with a site invitation or in open mode, else pending. */
      route<Context>("POST", /^\/api\/register$/, async (ctx): Promise<Registered> => {
        limit(ctx);
        const body = await ctx.body(),
          username = str(body, "username", 80).trim(),
          password = str(body, "password", 200),
          note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "",
          invite = typeof body.invite === "string" ? body.invite : "";
        if (!validUsername(username))
          fail(400, "用户名需 2–80 个字符，只能含文字、数字、空格和 _ . -");
        const mode = await registrationMode(ctx.store.db),
          hash = await passwordHash(password),
          id = uid();
        let active = mode === "open";
        try {
          await ctx.store.db.transaction(async (tx) => {
            if (invite) {
              const claimed = await tx.run(
                sql`UPDATE signup_invites SET used=used+1
                    WHERE token=${digest(invite)} AND NOT revoked AND used<uses AND expires>${Date.now()}`,
              );
              if (!claimed) fail(410, "邀请已失效");
              active = true;
            } else if (mode === "closed") fail(403, "暂不开放注册，请联系管理员获取邀请");
            await tx.run(
              sql`INSERT INTO users(id, username, password, admin, created, pending, note)
                  VALUES(${id}, ${username}, ${hash}, false, ${Date.now()}, ${!active}, ${note})`,
            );
          });
        } catch (error) {
          if (uniqueViolation(error)) fail(409, "用户名已存在");
          throw error;
        }
        if (!active) return { pending: true };
        const user: User = {
          id,
          username,
          password: hash,
          admin: false,
          mustChange: false,
          avatar: null,
        };
        await session(ctx.store, user, ctx.res, ctx.secure);
        return { pending: false, user: publicUser(user) };
      }),
      route<Context>("POST", /^\/api\/join$/, async (ctx): Promise<Registered> => {
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
          createdBy: string | null;
        }>(
          sql`SELECT project, role, expires, used, created_by AS "createdBy" FROM invites WHERE token=${digest(token)}`,
        );
        if (!invitation || invitation.used || invitation.expires < Date.now())
          fail(410, "邀请已失效");
        const existing = await byName(ctx, username);
        if (existing && !(await verifyPassword(password, existing.password)))
          fail(401, "该用户名已存在，请使用原密码");
        if (existing?.disabled) fail(403, "账号已停用，请联系管理员");
        if (existing?.pending) fail(403, "账号正在等待管理员审核");
        // A new account from a project owner's invitation still needs an administrator's approval.
        const fromAdmin =
          !!invitation.createdBy &&
          !!(await db.row(
            sql`SELECT 1 FROM users WHERE id=${invitation.createdBy} AND admin AND NOT disabled`,
          ));
        const pending = !existing && !fromAdmin;
        const user: User = existing ?? {
          id: uid(),
          username,
          password: await passwordHash(password),
          admin: false,
          mustChange: false,
          avatar: null,
        };
        try {
          await db.transaction(async (tx) => {
            const claimed = await tx.run(
              sql`UPDATE invites SET used=true WHERE token=${digest(token)} AND NOT used AND expires>${Date.now()}`,
            );
            if (!claimed) fail(410, "邀请已使用");
            if (!existing)
              await tx.run(
                sql`INSERT INTO users(id, username, password, admin, created, pending)
                    VALUES(${user.id}, ${username}, ${user.password}, false, ${Date.now()}, ${pending})`,
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
        if (pending) return { pending: true };
        await session(store, user, ctx.res, ctx.secure);
        return { pending: false, user: publicUser(user) };
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
