/**
 * Share links (anyone signed in who opens one joins the project as a viewer or editor), the
 * project's chat, and each member's own tags for their project list.
 */
import { randomBytes } from "node:crypto";
import type { ChatMessage, ProjectSummary, ShareLinks } from "../../shared/api";
import { sql } from "../db";
import { type Authed, type InProject, route, str } from "../http";
import { fail, type Role, uid } from "../util";
import { summaries } from "./projects";

const LINK_ROLES = ["viewer", "editor"] as const;
type LinkRole = (typeof LINK_ROLES)[number];
const linkRole = (value: string): LinkRole =>
  (LINK_ROLES as readonly string[]).includes(value) ? (value as LinkRole) : fail(400, "无效角色");
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
const tagName = (value: unknown) => {
  const tag = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!tag || tag.length > 40) fail(400, "标签需为 1–40 个字符");
  return tag;
};

async function links(ctx: InProject): Promise<ShareLinks> {
  const rows = await ctx.store.db.rows<{ role: LinkRole; token: string }>(
    sql`SELECT role, token FROM share_links WHERE project=${ctx.project}`,
  );
  const url = (role: LinkRole) => {
    const token = rows.find((r) => r.role === role)?.token;
    return token ? `${ctx.linkOrigin()}/?share=${token}` : null;
  };
  return { viewer: url("viewer"), editor: url("editor") };
}

export const shareRoutes = [
  route<InProject>("GET", /^share-links$/, async (ctx) => {
    await ctx.need("owner");
    return links(ctx);
  }),
  // Turns a link on (a new one each time) or off.
  route<InProject>("POST", /^share-links$/, async (ctx) => {
    await ctx.need("owner");
    const body = await ctx.body(),
      role = linkRole(str(body, "role", 20));
    await ctx.store.db.run(
      sql`DELETE FROM share_links WHERE project=${ctx.project} AND role=${role}`,
    );
    if (body.enabled === true)
      await ctx.store.db.run(
        sql`INSERT INTO share_links(project, role, token, created_by, created)
            VALUES(${ctx.project}, ${role}, ${randomBytes(24).toString("base64url")},
              ${ctx.user.id}, ${Date.now()})`,
      );
    await ctx.store.audit(ctx.project, ctx.user.id, "share.link", {
      role,
      enabled: body.enabled === true,
    });
    return links(ctx);
  }),
];

export const joinByLinkRoute = route<Authed>(
  "POST",
  /^\/api\/share\/join$/,
  async (ctx): Promise<ProjectSummary> => {
    const token = str(await ctx.body(), "token", 100);
    const link =
      (await ctx.store.db.row<{ project: string; role: LinkRole }>(
        sql`SELECT project, role FROM share_links WHERE token=${token}`,
      )) ?? fail(410, "分享链接已失效");
    const member = await ctx.store.db.row<{ role: Role }>(
      sql`SELECT role FROM members WHERE project=${link.project} AND user_id=${ctx.user.id}`,
    );
    // A link never lowers a member's role; an edit link raises a viewer's.
    if (!member || RANK[member.role] < RANK[link.role]) {
      await ctx.store.db.transaction(async (tx) => {
        await tx.run(
          sql`INSERT INTO members(project, user_id, role) VALUES(${link.project}, ${ctx.user.id}, ${link.role})
              ON CONFLICT (project, user_id) DO UPDATE SET role=excluded.role`,
        );
        await ctx.store.audit(link.project, ctx.user.id, "member.join", { link: link.role }, tx);
      });
      if (member) ctx.collab.refreshMember(link.project, ctx.user.id);
      ctx.collab.changed(link.project);
    }
    const [summary] = await summaries(ctx.store.db, ctx.user.id, link.project);
    return summary ?? fail(404, "项目不存在");
  },
);

export const chatRoutes = [
  route<InProject>("GET", /^chat$/, async (ctx): Promise<ChatMessage[]> => {
    const before = Number(ctx.url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const rows = await ctx.store.db.rows<ChatMessage>(
      sql`SELECT c.id, c.author, u.username AS "authorName", u.avatar_updated AS "authorAvatar",
                 c.body, c.created
          FROM chat_messages c JOIN users u ON u.id=c.author
          WHERE c.project=${ctx.project} AND c.created<${before}
          ORDER BY c.created DESC LIMIT 100`,
    );
    return rows.map((r) => ({ ...r, created: Number(r.created) })).reverse();
  }),
  route<InProject>("POST", /^chat$/, async (ctx): Promise<ChatMessage> => {
    const body = str(await ctx.body(), "body", 4000).trim();
    if (!body) fail(400, "消息不能为空");
    const message: ChatMessage = {
      id: uid(),
      author: ctx.user.id,
      authorName: ctx.user.username,
      authorAvatar: ctx.user.avatar,
      body,
      created: Date.now(),
    };
    await ctx.store.db.run(
      sql`INSERT INTO chat_messages(id, project, author, body, created)
          VALUES(${message.id}, ${ctx.project}, ${message.author}, ${body}, ${message.created})`,
    );
    ctx.collab.chat(ctx.project, message);
    return message;
  }),
];

export const tagRoutes = [
  // The member's tags for one project, replaced as a whole.
  route<InProject>("PUT", /^tags$/, async (ctx) => {
    const raw = (await ctx.body()).tags;
    if (!Array.isArray(raw) || raw.length > 20) fail(400, "无效字段 {key}", { key: "tags" });
    const tags = [...new Set(raw.map(tagName))];
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(
        sql`DELETE FROM project_tags WHERE user_id=${ctx.user.id} AND project=${ctx.project}`,
      );
      for (const tag of tags)
        await tx.run(
          sql`INSERT INTO project_tags(user_id, project, tag) VALUES(${ctx.user.id}, ${ctx.project}, ${tag})`,
        );
    });
    return { tags };
  }),
];
export const tagAccountRoutes = [
  route<Authed>("POST", /^\/api\/tags\/rename$/, async (ctx) => {
    const body = await ctx.body(),
      from = tagName(body.from),
      to = tagName(body.to);
    await ctx.store.db.transaction(async (tx) => {
      // Projects that already have the new name keep one.
      await tx.run(
        sql`DELETE FROM project_tags t WHERE t.user_id=${ctx.user.id} AND t.tag=${from}
            AND EXISTS (SELECT 1 FROM project_tags o WHERE o.user_id=t.user_id AND o.project=t.project AND o.tag=${to})`,
      );
      await tx.run(
        sql`UPDATE project_tags SET tag=${to} WHERE user_id=${ctx.user.id} AND tag=${from}`,
      );
    });
    return { ok: true };
  }),
  route<Authed>("POST", /^\/api\/tags\/delete$/, async (ctx) => {
    await ctx.store.db.run(
      sql`DELETE FROM project_tags WHERE user_id=${ctx.user.id} AND tag=${tagName((await ctx.body()).tag)}`,
    );
    return { ok: true };
  }),
];
