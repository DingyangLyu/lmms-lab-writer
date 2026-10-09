/** Projects, membership and the audit trail. */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validPath } from "@lmms-lab/sync";
import { unzipSync } from "fflate";
import * as Y from "yjs";
import type {
  AuditEntry,
  ImportedProject,
  Invite,
  Member,
  ProjectSummary,
  TemplateInfo,
} from "../../shared/api";
import { type Sql, sql } from "../db";
import { type Authed, created, handled, type InProject, roleInput, route, str } from "../http";
import { templateInfo } from "../templates";
import { decodeText, digest, fail, HttpError, isTextPath, safePath, textDoc, uid } from "../util";
import { PROJECT_BYTES, PROJECT_FILES } from "./files";

type NewFile = { path: string; data: Uint8Array };
const utf8 = new TextDecoder("utf-8", { fatal: true });
const TOO_LARGE = "项目超过 2000 个文件或 100 MB";

/** The dashboard's view of every project a user belongs to, or of one. */
const summaries = (q: Sql, user: string, project?: string) =>
  q.rows<ProjectSummary>(
    sql`SELECT p.id, p.name, p.created, p.updated, m.role, m.archived,
               m.trashed IS NOT NULL AS trashed,
               (SELECT u.username FROM members o JOIN users u ON u.id=o.user_id
                WHERE o.project=p.id AND o.role='owner' ORDER BY u.username LIMIT 1) AS owner
        FROM projects p JOIN members m ON p.id=m.project
        WHERE m.user_id=${user} AND (${project ?? null}::text IS NULL OR p.id=${project ?? null})
        ORDER BY p.updated DESC, p.created DESC`,
  );

/** Validates new files against the same limits as uploads and stores text as Yjs state. */
function prepare(files: NewFile[]) {
  if (files.length > PROJECT_FILES) fail(413, TOO_LARGE);
  let total = 0;
  return files.map(({ path, data }) => {
    safePath(path);
    if (data.length > 10_000_000) fail(413, "单文件超过 10 MB");
    const binary = !isTextPath(path);
    let state = data;
    if (!binary) {
      if (data.length > 2_000_000) fail(413, "文本文件超过 2 MB");
      let content = "";
      try {
        content = utf8.decode(data);
      } catch {
        fail(400, "{path} 不是 UTF-8 编码，请转换后再上传", { path });
      }
      const doc = textDoc(content);
      state = Y.encodeStateAsUpdate(doc);
      doc.destroy();
    }
    total += state.length;
    if (total > PROJECT_BYTES) fail(413, TOO_LARGE);
    return { path, binary, state };
  });
}

async function createProject(
  ctx: Authed,
  rawName: string,
  files: NewFile[],
  origin: Record<string, string>,
): Promise<ProjectSummary> {
  const name = rawName.trim();
  if (!name) fail(400, "请填写项目名");
  if (new Set(files.map((f) => f.path)).size !== files.length)
    fail(400, "压缩包中有重复的文件路径");
  const prepared = prepare(files);
  const id = uid(),
    now = Date.now();
  await ctx.store.db.transaction(async (tx) => {
    await tx.run(
      sql`INSERT INTO projects(id, name, created, updated) VALUES(${id}, ${name}, ${now}, ${now})`,
    );
    await tx.run(
      sql`INSERT INTO members(project, user_id, role) VALUES(${id}, ${ctx.user.id}, 'owner')`,
    );
    for (const f of prepared)
      await tx.run(
        sql`INSERT INTO files(id, project, path, state, is_binary)
            VALUES(${uid()}, ${id}, ${f.path}, ${f.state}, ${f.binary})`,
      );
    await ctx.store.audit(id, ctx.user.id, "project.create", origin, tx);
  });
  return {
    id,
    name,
    role: "owner",
    created: now,
    updated: now,
    owner: ctx.user.username,
    archived: false,
    trashed: false,
  };
}

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;
/**
 * Files of an uploaded zip. A zip of a single folder (how most tools export) loses that
 * folder; hidden entries such as .git are left out and reported.
 */
export function unpackZip(zip: Uint8Array) {
  let count = 0,
    total = 0;
  let entries: Record<string, Uint8Array> = {};
  try {
    entries = unzipSync(zip, {
      filter: (file) => {
        if (file.name.endsWith("/") || JUNK.test(file.name)) return false;
        count++;
        total += file.originalSize;
        if (count > PROJECT_FILES || total > PROJECT_BYTES) fail(413, TOO_LARGE);
        if (file.originalSize > 10_000_000) fail(413, "单文件超过 10 MB");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, "无法读取压缩包，请上传 .zip 文件");
  }
  const named = Object.entries(entries).map(([name, data]) => ({
    name: name.replace(/\\/g, "/"),
    data,
  }));
  const top = named[0]?.name.split("/")[0] ?? "";
  const prefix = named.length && named.every((e) => e.name.startsWith(`${top}/`)) ? `${top}/` : "";
  const files: NewFile[] = [],
    skipped: string[] = [];
  for (const { name, data } of named) {
    const path = name.slice(prefix.length);
    if (validPath(path)) files.push({ path, data });
    else skipped.push(name);
  }
  if (!files.length) fail(400, "压缩包里没有可用的文件");
  return { files, skipped };
}

export const projectListRoutes = [
  route<Authed>("GET", /^\/api\/projects$/, (ctx) => summaries(ctx.store.db, ctx.user.id)),
  route<Authed>("POST", /^\/api\/projects$/, async (ctx) => {
    const body = await ctx.body(),
      name = str(body, "name", 120);
    if (body.template === undefined || body.template === null)
      return created(await createProject(ctx, name, [], { from: "blank" }));
    const id = str(body, "template", 64);
    const template = (await ctx.templates()).get(id) ?? fail(404, "模板不存在");
    return created(await createProject(ctx, name, template.files, { template: id }));
  }),
  route<Authed>("POST", /^\/api\/projects\/import$/, async (ctx): Promise<ImportedProject> => {
    const body = await ctx.body(),
      name = str(body, "name", 120),
      zip = str(body, "base64", 16_000_000);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(zip)) fail(400, "无效文件编码");
    const { files, skipped } = unpackZip(Buffer.from(zip, "base64"));
    return { ...(await createProject(ctx, name, files, { from: "zip" })), skipped };
  }),
  route<Authed>(
    "GET",
    /^\/api\/templates$/,
    async (ctx): Promise<TemplateInfo[]> => [...(await ctx.templates()).values()].map(templateInfo),
  ),
  route<Authed>("GET", /^\/api\/templates\/([a-z0-9-]+)\/preview$/, async (ctx, [id = ""]) => {
    const file = (await ctx.templates()).get(id)?.previewFile ?? fail(404, "模板不存在");
    ctx.res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=3600" });
    ctx.res.end(await readFile(file));
    return handled;
  }),
];

export const projectRoutes = [
  route<InProject>(
    "GET",
    /^$/,
    async (ctx): Promise<ProjectSummary> =>
      (await summaries(ctx.store.db, ctx.user.id, ctx.project))[0] ?? fail(404, "项目不存在"),
  ),
  route<InProject>("POST", /^copy$/, async (ctx) => {
    const name = str(await ctx.body(), "name", 120);
    const files = (await ctx.store.projectFiles(ctx.project)).map((f) => ({
      path: f.path,
      data: f.binary ? f.state : Buffer.from(decodeText(f.state)),
    }));
    return created(await createProject(ctx, name, files, { copiedFrom: ctx.project }));
  }),
  // Archive and trash exclude each other, as in Overleaf.
  route<InProject>("POST", /^archive$/, async (ctx) => {
    const archived = (await ctx.body()).archived === true;
    await ctx.store.db.run(
      archived
        ? sql`UPDATE members SET archived=true, trashed=NULL WHERE project=${ctx.project} AND user_id=${ctx.user.id}`
        : sql`UPDATE members SET archived=false WHERE project=${ctx.project} AND user_id=${ctx.user.id}`,
    );
    return { ok: true };
  }),
  route<InProject>("POST", /^trash$/, async (ctx) => {
    const trashed = (await ctx.body()).trashed === true;
    await ctx.store.db.run(
      trashed
        ? sql`UPDATE members SET trashed=${Date.now()}, archived=false WHERE project=${ctx.project} AND user_id=${ctx.user.id}`
        : sql`UPDATE members SET trashed=NULL WHERE project=${ctx.project} AND user_id=${ctx.user.id}`,
    );
    return { ok: true };
  }),
  route<InProject>("POST", /^leave$/, async (ctx) => {
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(
        sql`DELETE FROM members WHERE project=${ctx.project} AND user_id=${ctx.user.id}`,
      );
      const owners = await tx.row<{ n: number }>(
        sql`SELECT count(*) AS n FROM members WHERE project=${ctx.project} AND role='owner'`,
      );
      if (!owners?.n) fail(409, "项目至少需要一名所有者");
      await ctx.store.audit(ctx.project, ctx.user.id, "member.leave", {}, tx);
    });
    ctx.collab.revoke(ctx.project, ctx.user.id);
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
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
