/**
 * People: profile pictures, finding colleagues by name, and friends — the people a member can
 * add to a project in one step instead of sending an invitation link.
 */
import type { FoundUser, Friends, Person } from "../../shared/api";
import { sql } from "../db";
import { type Authed, handled, type InProject, readBody, roleInput, route, str } from "../http";
import { fail } from "../util";

/** Pictures are shrunk to 256 px in the browser; this leaves room for a large PNG. */
const AVATAR_BYTES = 1_000_000;
const IMAGE_TYPES: Array<[string, (b: Buffer) => boolean]> = [
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [
    "image/webp",
    (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP",
  ],
];

// Only approved, enabled accounts that were not deleted appear to others.
async function friendsOf(ctx: Authed): Promise<Friends> {
  const rows = await ctx.store.db.rows<Person & { requester: string; accepted: boolean }>(
    sql`SELECT u.id, u.username, u.avatar_updated AS avatar, f.requester, f.accepted
        FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester=${ctx.user.id} THEN f.addressee ELSE f.requester END
        WHERE (f.requester=${ctx.user.id} OR f.addressee=${ctx.user.id}) AND NOT u.pending AND NOT u.disabled AND NOT u.deleted
        ORDER BY u.username`,
  );
  const person = ({ id, username, avatar }: Person): Person => ({ id, username, avatar });
  return {
    friends: rows.filter((r) => r.accepted).map(person),
    incoming: rows.filter((r) => !r.accepted && r.requester !== ctx.user.id).map(person),
    outgoing: rows.filter((r) => !r.accepted && r.requester === ctx.user.id).map(person),
  };
}
const isFriend = async (ctx: Authed, other: string) =>
  !!(await ctx.store.db.row(
    sql`SELECT 1 FROM friendships
        WHERE accepted AND ((requester=${ctx.user.id} AND addressee=${other})
                         OR (requester=${other} AND addressee=${ctx.user.id}))`,
  ));

export const peopleRoutes = [
  route<Authed>("GET", /^\/api\/users\/search$/, async (ctx): Promise<FoundUser[]> => {
    const q = (ctx.url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (!q || q.length > 64) return [];
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const found = await ctx.store.db.rows<Person>(
      sql`SELECT u.id, u.username, u.avatar_updated AS avatar FROM users u
          WHERE lower(u.username) LIKE ${like} AND u.id<>${ctx.user.id} AND NOT u.pending AND NOT u.disabled AND NOT u.deleted
          ORDER BY (lower(u.username)=${q}) DESC, length(u.username), u.username LIMIT 10`,
    );
    const { friends, incoming, outgoing } = await friendsOf(ctx);
    const among = (list: Person[], id: string) => list.some((p) => p.id === id);
    return found.map((p) => ({
      ...p,
      relation: among(friends, p.id)
        ? "friend"
        : among(incoming, p.id)
          ? "incoming"
          : among(outgoing, p.id)
            ? "outgoing"
            : "none",
    }));
  }),
  route<Authed>("GET", /^\/api\/users\/([^/]+)\/avatar$/, async (ctx, [id = ""]) => {
    const row =
      (await ctx.store.db.row<{ avatar: Uint8Array | null; type: string | null; updated: number }>(
        sql`SELECT avatar, avatar_type AS type, avatar_updated AS updated FROM users WHERE id=${id} AND NOT deleted`,
      )) ?? fail(404, "用户不存在");
    if (!row.avatar || !row.type) fail(404, "没有头像");
    // The page asks with ?v=<updated>, so a version never changes once fetched.
    const versioned = ctx.url.searchParams.get("v") === String(row.updated);
    ctx.res.writeHead(200, {
      "Content-Type": row.type,
      "Content-Length": row.avatar.length,
      "Cache-Control": versioned ? "private, max-age=31536000, immutable" : "no-cache",
    });
    ctx.res.end(row.avatar);
    return handled;
  }),
  route<Authed>("PUT", /^\/api\/me\/avatar$/, async (ctx) => {
    const bytes = await readBody(ctx.req, AVATAR_BYTES, "头像图片超过 {size}");
    const type =
      IMAGE_TYPES.find(([, test]) => test(bytes))?.[0] ??
      fail(400, "头像须为 PNG、JPEG 或 WebP 图片");
    const updated = Date.now();
    await ctx.store.db.run(
      sql`UPDATE users SET avatar=${bytes}, avatar_type=${type}, avatar_updated=${updated} WHERE id=${ctx.user.id}`,
    );
    return { avatar: updated };
  }),
  route<Authed>("DELETE", /^\/api\/me\/avatar$/, async (ctx) => {
    await ctx.store.db.run(
      sql`UPDATE users SET avatar=NULL, avatar_type=NULL, avatar_updated=NULL WHERE id=${ctx.user.id}`,
    );
    return { avatar: null };
  }),
  route<Authed>("GET", /^\/api\/friends$/, (ctx) => friendsOf(ctx)),
  // Asking someone who already asked you accepts their request.
  route<Authed>("POST", /^\/api\/friends$/, async (ctx): Promise<Friends> => {
    const name = str(await ctx.body(), "username", 64).trim();
    const other =
      (await ctx.store.db.row<{ id: string }>(
        sql`SELECT u.id FROM users u WHERE lower(u.username)=${name.toLowerCase()} AND NOT u.pending AND NOT u.disabled AND NOT u.deleted`,
      )) ?? fail(404, "用户不存在");
    if (other.id === ctx.user.id) fail(400, "不能添加自己为好友");
    const existing = await ctx.store.db.row<{ requester: string; accepted: boolean }>(
      sql`SELECT requester, accepted FROM friendships
          WHERE (requester=${ctx.user.id} AND addressee=${other.id})
             OR (requester=${other.id} AND addressee=${ctx.user.id})`,
    );
    if (existing?.accepted) fail(409, "你们已经是好友");
    if (existing && existing.requester === other.id)
      await ctx.store.db.run(
        sql`UPDATE friendships SET accepted=true WHERE requester=${other.id} AND addressee=${ctx.user.id}`,
      );
    else if (!existing)
      await ctx.store.db.run(
        sql`INSERT INTO friendships(requester, addressee, accepted, created)
            VALUES(${ctx.user.id}, ${other.id}, false, ${Date.now()})`,
      );
    return friendsOf(ctx);
  }),
  route<Authed>("POST", /^\/api\/friends\/([^/]+)\/accept$/, async (ctx, [id = ""]) => {
    const changed = await ctx.store.db.run(
      sql`UPDATE friendships SET accepted=true WHERE requester=${id} AND addressee=${ctx.user.id} AND NOT accepted`,
    );
    if (!changed) fail(404, "好友申请不存在");
    return friendsOf(ctx);
  }),
  // Removing a friend, declining a request and withdrawing one's own are the same.
  route<Authed>("DELETE", /^\/api\/friends\/([^/]+)$/, async (ctx, [id = ""]) => {
    await ctx.store.db.run(
      sql`DELETE FROM friendships
          WHERE (requester=${ctx.user.id} AND addressee=${id}) OR (requester=${id} AND addressee=${ctx.user.id})`,
    );
    return friendsOf(ctx);
  }),
];

/** An owner adds a friend to the project directly, with any role but owner. */
export const addMemberRoute = route<InProject>("POST", /^members$/, async (ctx) => {
  await ctx.need("owner");
  const body = await ctx.body();
  const user = str(body, "user", 64),
    role = roleInput(str(body, "role"));
  if (role === "owner") fail(400, "邀请不能授予所有者角色");
  if (!(await isFriend(ctx, user))) fail(403, "只能直接添加好友，其他人请发送邀请链接");
  const added = await ctx.store.db.transaction(async (tx) => {
    const exists = await tx.row(
      sql`SELECT 1 FROM members WHERE project=${ctx.project} AND user_id=${user}`,
    );
    if (exists) fail(409, "对方已经是项目成员");
    await tx.run(
      sql`INSERT INTO members(project, user_id, role) VALUES(${ctx.project}, ${user}, ${role})`,
    );
    await ctx.store.audit(ctx.project, ctx.user.id, "member.add", { user, role }, tx);
    return true;
  });
  ctx.collab.changed(ctx.project);
  return { ok: added };
});
