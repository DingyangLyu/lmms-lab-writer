/** Projects, membership and the audit trail. */
import { randomBytes } from "node:crypto";
import { validPath } from "@lmms-lab/sync";
import { unzipSync } from "fflate";
import * as Y from "yjs";
import type { AuditEntry, ImportedProject, Invite, Member, ProjectSummary } from "../../shared/api";
import { type Sql, sql } from "../db";
import { type Authed, created, type InProject, readBody, roleInput, route, str } from "../http";
import {
  BINARY_BYTES,
  PROJECT_BYTES,
  PROJECT_FILES,
  sizeText,
  TEXT_BYTES,
  ZIP_BYTES,
} from "../limits";
import { decodeText, digest, fail, isTextPath, safePath, textDoc, uid } from "../util";
import { fileTooLarge, projectTooLarge } from "./files";

type NewFile = { path: string; data: Uint8Array };
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The dashboard's view of every project a user belongs to, or of one. */
const summaries = (q: Sql, user: string, project?: string) =>
  q.rows<ProjectSummary>(
    sql`SELECT p.id, p.name, p.created, p.updated, m.role, m.archived,
               m.trashed IS NOT NULL AS trashed,
               (SELECT u.username FROM members o JOIN users u ON u.id=o.user_id
                WHERE o.project=p.id AND o.role='owner' ORDER BY u.username LIMIT 1) AS owner,
               (SELECT u.id FROM members o JOIN users u ON u.id=o.user_id
                WHERE o.project=p.id AND o.role='owner' ORDER BY u.username LIMIT 1) AS "ownerId",
               (SELECT u.avatar_updated FROM members o JOIN users u ON u.id=o.user_id
                WHERE o.project=p.id AND o.role='owner' ORDER BY u.username LIMIT 1) AS "ownerAvatar"
        FROM projects p JOIN members m ON p.id=m.project
        WHERE m.user_id=${user} AND (${project ?? null}::text IS NULL OR p.id=${project ?? null})
        ORDER BY p.updated DESC, p.created DESC`,
  );

/** Checks files against the project's limits as they arrive, and stores text as Yjs state. */
class Intake {
  private count = 0;
  private total = 0;
  private paths = new Set<string>();
  prepare(files: NewFile[]) {
    return files.map(({ path, data }) => {
      safePath(path);
      if (this.paths.has(path)) fail(400, "压缩包中有重复的文件路径");
      this.paths.add(path);
      if (++this.count > PROJECT_FILES) projectTooLarge();
      const binary = !isTextPath(path);
      let state = data;
      if (binary && data.length > BINARY_BYTES) fileTooLarge();
      if (!binary) {
        if (data.length > TEXT_BYTES) fail(413, "文本文件超过 2 MB");
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
      this.total += state.length;
      if (this.total > PROJECT_BYTES) projectTooLarge();
      return { path, binary, state };
    });
  }
}

/** A new project owned by the user; `batches` are read one at a time, inside the transaction. */
async function createProject(
  ctx: Authed,
  rawName: string,
  batches: Iterable<NewFile[]>,
  origin: Record<string, string>,
): Promise<ProjectSummary> {
  const name = rawName.trim();
  if (!name) fail(400, "请填写项目名");
  if ([...name].length > 120) fail(400, "无效字段 {key}", { key: "name" });
  const intake = new Intake();
  const id = uid(),
    now = Date.now();
  await ctx.store.db.transaction(async (tx) => {
    await tx.run(
      sql`INSERT INTO projects(id, name, created, updated) VALUES(${id}, ${name}, ${now}, ${now})`,
    );
    await tx.run(
      sql`INSERT INTO members(project, user_id, role) VALUES(${id}, ${ctx.user.id}, 'owner')`,
    );
    for (const batch of batches)
      for (const f of intake.prepare(batch))
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
/** How much an import unpacks at a time. */
const BATCH_BYTES = 64_000_000;
const unreadable = () => fail(400, "无法读取压缩包，请上传 .zip 文件");
/**
 * An uploaded zip, checked against the limits from its directory before anything is unpacked
 * and then unpacked in batches, so a large archive is never held decompressed at once. A zip
 * of a single folder (how most tools export) loses that folder; hidden entries such as .git
 * are left out and reported.
 */
export function readZip(zip: Uint8Array, batchBytes = BATCH_BYTES) {
  const listed: Array<{ name: string; size: number }> = [];
  try {
    unzipSync(zip, {
      filter: (file) => {
        if (!file.name.endsWith("/") && !JUNK.test(file.name))
          listed.push({ name: file.name, size: file.originalSize });
        return false;
      },
    });
  } catch {
    unreadable();
  }
  const normal = (name: string) => name.replace(/\\/g, "/");
  const top = normal(listed[0]?.name ?? "").split("/")[0] ?? "";
  const prefix =
    listed.length && listed.every((e) => normal(e.name).startsWith(`${top}/`)) ? `${top}/` : "";
  const entries: Array<{ name: string; path: string; size: number }> = [],
    skipped: string[] = [];
  let total = 0;
  for (const { name, size } of listed) {
    const path = normal(name).slice(prefix.length);
    if (!validPath(path)) {
      skipped.push(name);
      continue;
    }
    if (isTextPath(path) ? size > TEXT_BYTES : size > BINARY_BYTES)
      fail(413, "{path} 超过 {size}", {
        path,
        size: sizeText(isTextPath(path) ? TEXT_BYTES : BINARY_BYTES),
      });
    total += size;
    entries.push({ name, path, size });
  }
  if (entries.length > PROJECT_FILES || total > PROJECT_BYTES) projectTooLarge();
  if (!entries.length) fail(400, "压缩包里没有可用的文件");
  function* batches(): Generator<NewFile[]> {
    for (let i = 0; i < entries.length; ) {
      const batch = new Map<string, string>();
      for (let bytes = 0; i < entries.length; i++) {
        const entry = entries[i] as (typeof entries)[number];
        if (batch.size && bytes + entry.size > batchBytes) break;
        batch.set(entry.name, entry.path);
        bytes += entry.size;
      }
      let unpacked: Record<string, Uint8Array> = {};
      try {
        unpacked = unzipSync(zip, { filter: (file) => batch.has(file.name) });
      } catch {
        unreadable();
      }
      yield [...batch].map(([name, path]) => ({ path, data: unpacked[name] ?? unreadable() }));
    }
  }
  return { skipped, batches };
}

export const projectListRoutes = [
  route<Authed>("GET", /^\/api\/projects$/, (ctx) => summaries(ctx.store.db, ctx.user.id)),
  route<Authed>("POST", /^\/api\/projects$/, async (ctx) => {
    const body = await ctx.body(),
      name = str(body, "name", 120);
    if (body.template === undefined || body.template === null)
      return created(await createProject(ctx, name, [], { from: "blank" }));
    const id = str(body, "template", 64);
    const files = await ctx.templates.files(id);
    return created(await createProject(ctx, name, [files], { template: id }));
  }),
  // The zip is the request body (up to 500 MB), the project's name a query parameter.
  route<Authed>("POST", /^\/api\/projects\/import$/, async (ctx): Promise<ImportedProject> => {
    const name = ctx.url.searchParams.get("name") ?? "";
    const zip = await readBody(ctx.req, ZIP_BYTES, "压缩包超过 {size}");
    const { skipped, batches } = readZip(zip);
    return { ...(await createProject(ctx, name, batches(), { from: "zip" })), skipped };
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
    return created(await createProject(ctx, name, [files], { copiedFrom: ctx.project }));
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
      sql`SELECT u.id, u.username, m.role, u.avatar_updated AS avatar
          FROM members m JOIN users u ON u.id=m.user_id
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
    return { token, url: `${ctx.linkOrigin()}/?invite=${token}`, expiresInDays: 7 };
  }),
  route<InProject>("GET", /^audit$/, (ctx) =>
    ctx.store.db.rows<AuditEntry>(
      sql`SELECT a.id, a.actor, a.action, a.detail, a.created, u.username AS name
          FROM audit a LEFT JOIN users u ON a.actor=u.id
          WHERE a.project=${ctx.project} ORDER BY a.created DESC LIMIT 200`,
    ),
  ),
];
