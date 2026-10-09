/** Project files: listing, upload, read, collaborative replace, rename, delete, export. */
import { zipSync } from "fflate";
import * as Y from "yjs";
import type { FileContent, FileInfo, SourceFile } from "../../shared/api";
import { sql, uniqueViolation } from "../db";
import { type Body, created, handled, type InProject, number, route, str } from "../http";
import type { FileMeta } from "../store";
import { decodeText, fail, isTextPath, safePath, textDoc, uid } from "../util";

export const PROJECT_FILES = 2000,
  PROJECT_BYTES = 100_000_000;

/**
 * New content for a figure or other binary file, guarded by the revision the client last saw.
 * One automatic version per five minutes keeps the replaced content restorable without a
 * full project copy for every regenerated plot.
 */
async function replaceBinary(ctx: InProject, file: FileMeta, body: Body) {
  const { store, project } = ctx;
  const value = str(body, "base64", 14_000_000),
    revision = number(body, "revision");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(400, "无效文件编码");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 10_000_000) fail(413, "单文件超过 10 MB");
  const saved = await store.db.transaction(async (tx) => {
    const size = await tx.row<{ bytes: number }>(
      sql`SELECT coalesce(sum(length(state)),0) AS bytes FROM files WHERE project=${project} AND id<>${file.id}`,
    );
    if ((size?.bytes ?? 0) + bytes.length > PROJECT_BYTES) fail(413, "项目超过 100 MB");
    const recent = await tx.row(
      sql`SELECT 1 FROM snapshots WHERE project=${project} AND NOT manual AND created>${Date.now() - 300_000}`,
    );
    if (!recent) await store.snapshot(project, ctx.user.id, "替换文件前", false, tx);
    const row =
      (await tx.row<{ revision: number }>(
        sql`UPDATE files SET state=${bytes}, revision=revision+1
            WHERE id=${file.id} AND revision=${revision} AND NOT deleted RETURNING revision`,
      )) ?? fail(409, "文件已被其他人更新，请先同步");
    await store.audit(project, ctx.user.id, "file.replace", { file: file.id, path: file.path }, tx);
    return row.revision;
  });
  ctx.collab.changed(project);
  return { ok: true, revision: saved };
}

export const fileRoutes = [
  route<InProject>("GET", /^files$/, (ctx) =>
    ctx.store.db.rows<FileInfo>(
      sql`SELECT id, path, is_binary AS "binary", revision FROM files
          WHERE project=${ctx.project} AND NOT deleted ORDER BY path`,
    ),
  ),
  route<InProject>("POST", /^files$/, async (ctx) => {
    await ctx.need("edit");
    const { store, project } = ctx,
      body = await ctx.body(),
      path = safePath(str(body, "path", 240));
    const binary = !isTextPath(path);
    const value = str(body, binary ? "base64" : "content", binary ? 14_000_000 : 2_000_000);
    let bytes: Uint8Array;
    if (binary) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(400, "无效文件编码");
      bytes = Buffer.from(value, "base64");
    } else {
      if (Buffer.byteLength(value) > 2_000_000) fail(413, "文本文件超过 2 MB");
      const d = textDoc(value);
      bytes = Y.encodeStateAsUpdate(d);
      d.destroy();
    }
    if (bytes.length > 10_000_000) fail(413, "单文件超过 10 MB");
    const limits = await store.db.row<{ count: number; bytes: number }>(
      sql`SELECT count(*) AS count, coalesce(sum(length(state)),0) AS bytes FROM files WHERE project=${project}`,
    );
    if (
      (limits?.count ?? 0) >= PROJECT_FILES ||
      (limits?.bytes ?? 0) + bytes.length > PROJECT_BYTES
    )
      fail(413, "项目超过 2000 个文件或 100 MB");
    const id = uid();
    try {
      await store.db.transaction(async (tx) => {
        await store.releasePath(project, path, tx);
        await tx.run(
          sql`INSERT INTO files(id, project, path, state, is_binary) VALUES(${id}, ${project}, ${path}, ${bytes}, ${binary})`,
        );
        await store.audit(project, ctx.user.id, "file.create", { id, path }, tx);
      });
    } catch (error) {
      if (uniqueViolation(error)) fail(409, "同名文件已存在，请在编辑器中更新");
      throw error;
    }
    ctx.collab.changed(project);
    return created({ id, path, binary, revision: 1 } satisfies FileInfo);
  }),
  route<InProject>("GET", /^files\/([^/]+)$/, async (ctx, [id = ""]): Promise<FileContent> => {
    const file = await ctx.store.fileMeta(ctx.project, id);
    const state = await ctx.store.fileState(file.id);
    return {
      id: file.id,
      path: file.path,
      binary: file.binary,
      revision: file.revision,
      ...(file.binary
        ? { base64: Buffer.from(state).toString("base64") }
        : { content: decodeText(state) }),
    };
  }),
  route<InProject>("PUT", /^files\/([^/]+)$/, async (ctx, [id = ""]) => {
    await ctx.need("edit");
    const file = await ctx.store.fileMeta(ctx.project, id);
    const body = await ctx.body();
    if (file.binary) return replaceBinary(ctx, file, body);
    await ctx.collab.replace(
      ctx.project,
      file.id,
      str(body, "expected", 2_000_000),
      str(body, "content", 2_000_000),
      ctx.user.id,
    );
    return { ok: true };
  }),
  route<InProject>("PATCH", /^files\/([^/]+)$/, async (ctx, [id = ""]) => {
    await ctx.need("edit");
    const { store, project } = ctx,
      file = await store.fileMeta(project, id),
      path = safePath(str(await ctx.body(), "path", 240));
    if (isTextPath(path) === file.binary)
      fail(400, "重命名不能改变文本／二进制文件类型，请上传为新文件");
    try {
      await store.db.transaction(async (tx) => {
        await store.releasePath(project, path, tx);
        await tx.run(sql`UPDATE files SET path=${path} WHERE id=${file.id}`);
        await store.audit(
          project,
          ctx.user.id,
          "file.rename",
          { file: file.id, from: file.path, path },
          tx,
        );
      });
    } catch (error) {
      if (uniqueViolation(error)) fail(409, "目标路径已有文件");
      throw error;
    }
    ctx.collab.changed(project);
    return { ok: true };
  }),
  route<InProject>("DELETE", /^files\/([^/]+)$/, async (ctx, [id = ""]) => {
    await ctx.need("edit");
    const { store, project } = ctx,
      file = await store.fileMeta(project, id);
    await store.db.transaction(async (tx) => {
      await store.snapshot(project, ctx.user.id, "删除文件前", false, tx);
      await tx.run(sql`UPDATE files SET deleted=true WHERE id=${file.id}`);
      await store.audit(
        project,
        ctx.user.id,
        "file.delete",
        { file: file.id, path: file.path },
        tx,
      );
    });
    ctx.collab.closeFile(file.id, "文件已删除");
    ctx.collab.changed(project);
    return { ok: true };
  }),
  route<InProject>(
    "GET",
    /^sources$/,
    (ctx): Promise<SourceFile[]> => ctx.store.textFiles(ctx.project),
  ),
  route<InProject>("GET", /^export$/, async (ctx) => {
    const { store, project } = ctx;
    const entries: Record<string, Uint8Array> = {};
    for (const f of await store.projectFiles(project))
      entries[safePath(f.path)] = f.binary ? f.state : Buffer.from(decodeText(f.state));
    entries["writer-collaboration-notes.json"] = Buffer.from(
      JSON.stringify(
        {
          comments: await store.db.rows(
            sql`SELECT id, file, author, quote, body, resolved, created, updated
                FROM comments WHERE project=${project}`,
          ),
          audit: await store.db.rows(
            sql`SELECT actor, action, detail, created FROM audit WHERE project=${project} ORDER BY created`,
          ),
        },
        null,
        2,
      ),
    );
    const name =
      (await store.db.row<{ name: string }>(sql`SELECT name FROM projects WHERE id=${project}`))
        ?.name ?? "writer-project";
    ctx.res.writeHead(200, {
      "Content-Type": "application/zip",
      // The ASCII name is for old clients; browsers use the UTF-8 project name.
      "Content-Disposition": `attachment; filename="writer-project.zip"; filename*=UTF-8''${encodeURIComponent(`${name}.zip`)}`,
    });
    ctx.res.end(zipSync(entries));
    return handled;
  }),
];
