/** Projects, membership and the audit trail. */
import { randomBytes } from "node:crypto";
import type { AuditEntry, Invite, Member, ProjectSummary } from "../../shared/api";
import { sql } from "../db";
import { type Authed, created, type InProject, roleInput, route, str } from "../http";
import { digest, fail, uid } from "../util";

export const projectListRoutes = [
  route<Authed>("GET", /^\/api\/projects$/, (ctx) =>
    ctx.store.db.rows<ProjectSummary>(
      sql`SELECT p.id, p.name, p.created, m.role FROM projects p JOIN members m ON p.id=m.project
          WHERE m.user_id=${ctx.user.id} ORDER BY p.created DESC`,
    ),
  ),
  route<Authed>("POST", /^\/api\/projects$/, async (ctx) => {
    const name = str(await ctx.body(), "name", 120).trim();
    if (!name) fail(400, "请填写项目名");
    const id = uid();
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(
        sql`INSERT INTO projects(id, name, created) VALUES(${id}, ${name}, ${Date.now()})`,
      );
      await tx.run(
        sql`INSERT INTO members(project, user_id, role) VALUES(${id}, ${ctx.user.id}, 'owner')`,
      );
    });
    return created({ id, name, role: "owner" } satisfies ProjectSummary);
  }),
];

export const projectRoutes = [
  route<InProject>(
    "GET",
    /^$/,
    async (ctx): Promise<ProjectSummary> => ({
      ...((await ctx.store.db.row<{ id: string; name: string; created: number }>(
        sql`SELECT id, name, created FROM projects WHERE id=${ctx.project}`,
      )) ?? fail(404, "项目不存在")),
      role: ctx.role,
    }),
  ),
  route<InProject>("PATCH", /^$/, async (ctx) => {
    await ctx.need("owner");
    const name = str(await ctx.body(), "name", 120).trim();
    if (!name) fail(400, "请填写项目名");
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(sql`UPDATE projects SET name=${name} WHERE id=${ctx.project}`);
      await ctx.store.audit(ctx.project, ctx.user.id, "project.rename", { name }, tx);
    });
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
  route<InProject>("DELETE", /^$/, async (ctx) => {
    await ctx.need("owner");
    const current = await ctx.store.db.row<{ name: string }>(
      sql`SELECT name FROM projects WHERE id=${ctx.project}`,
    );
    if (str(await ctx.body(), "confirm", 120) !== current?.name)
      fail(400, "请输入完整项目名确认删除");
    // Close editors first so no edit races the cascade.
    await ctx.collab.closeProject(ctx.project, "项目已被删除");
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(sql`DELETE FROM audit WHERE project=${ctx.project}`);
      await tx.run(sql`DELETE FROM projects WHERE id=${ctx.project}`);
    });
    return { ok: true };
  }),
  route<InProject>("GET", /^members$/, (ctx) =>
    ctx.store.db.rows<Member>(
      sql`SELECT u.id, u.username, m.role FROM members m JOIN users u ON u.id=m.user_id
          WHERE m.project=${ctx.project} ORDER BY u.username`,
    ),
  ),
  route<InProject>("PATCH", /^members\/([^/]+)$/, async (ctx, [target = ""]) => {
    await ctx.need("owner");
    const next = roleInput(str(await ctx.body(), "role"));
    await ctx.store.db.transaction(async (tx) => {
      const changed = await tx.run(
        sql`UPDATE members SET role=${next} WHERE project=${ctx.project} AND user_id=${target}`,
      );
      if (!changed) fail(404, "成员不存在");
      const owners = await tx.row<{ n: number }>(
        sql`SELECT count(*) AS n FROM members WHERE project=${ctx.project} AND role='owner'`,
      );
      if (!owners?.n) fail(409, "项目至少需要一名所有者");
      await ctx.store.audit(
        ctx.project,
        ctx.user.id,
        "member.role",
        { user: target, role: next },
        tx,
      );
    });
    // Reconnect their editors so the new role applies immediately.
    ctx.collab.refreshMember(ctx.project, target);
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
  route<InProject>("DELETE", /^members\/([^/]+)$/, async (ctx, [target = ""]) => {
    await ctx.need("owner");
    if (target === ctx.user.id) fail(400, "不能撤销自己的所有者权限");
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(sql`DELETE FROM members WHERE project=${ctx.project} AND user_id=${target}`);
      await ctx.store.audit(ctx.project, ctx.user.id, "member.revoke", { user: target }, tx);
    });
    ctx.collab.revoke(ctx.project, target);
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
  route<InProject>("POST", /^invite$/, async (ctx): Promise<Invite> => {
    await ctx.need("owner");
    const invited = roleInput(str(await ctx.body(), "role"));
    if (invited === "owner") fail(400, "邀请不能授予所有者角色");
    const token = randomBytes(32).toString("hex");
    await ctx.store.db.run(
      sql`INSERT INTO invites(token, project, role, expires, created_by)
          VALUES(${digest(token)}, ${ctx.project}, ${invited}, ${Date.now() + 7 * 86400000}, ${ctx.user.id})`,
    );
    return { token, url: `${ctx.origin()}/?invite=${token}`, expiresInDays: 7 };
  }),
  route<InProject>("GET", /^audit$/, (ctx) =>
    ctx.store.db.rows<AuditEntry>(
      sql`SELECT a.id, a.actor, a.action, a.detail, a.created, u.username AS name
          FROM audit a LEFT JOIN users u ON a.actor=u.id
          WHERE a.project=${ctx.project} ORDER BY a.created DESC LIMIT 200`,
    ),
  ),
];
