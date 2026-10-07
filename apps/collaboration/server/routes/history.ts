/** Project versions: list, save, compare with now, restore one file. */
import type { Snapshot, SnapshotChange } from "../../shared/api";
import { sql } from "../db";
import { created, type InProject, route, str } from "../http";
import { decodeText, fail } from "../util";

type SnapshotData = {
  files: Array<{
    id: string;
    path: string;
    state: string;
    binary: boolean | number;
    deleted: boolean | number;
  }>;
};
const savedFiles = async (ctx: InProject, id: string) => {
  const saved =
    (await ctx.store.db.row<{ data: string }>(
      sql`SELECT data FROM snapshots WHERE id=${id} AND project=${ctx.project}`,
    )) ?? fail(404, "版本不存在");
  return (JSON.parse(saved.data) as SnapshotData).files.filter((f) => !f.deleted);
};

export const historyRoutes = [
  route<InProject>("GET", /^snapshots$/, (ctx) =>
    ctx.store.db.rows<Snapshot>(
      sql`SELECT id, label, author, created, manual FROM snapshots
          WHERE project=${ctx.project} ORDER BY created DESC LIMIT 100`,
    ),
  ),
  route<InProject>("POST", /^snapshots$/, async (ctx) => {
    await ctx.need("edit");
    const body = await ctx.body();
    const label =
      typeof body.label === "string" && body.label.trim()
        ? str(body, "label", 200).trim()
        : "手动版本";
    const id = await ctx.store.snapshot(ctx.project, ctx.user.id, label, true);
    ctx.collab.changed(ctx.project);
    return created({ id });
  }),
  route<InProject>("GET", /^snapshots\/([^/]+)\/changes$/, async (ctx, [id = ""]) => {
    const old = await savedFiles(ctx, id);
    const now = await ctx.store.projectFiles(ctx.project);
    const changes: SnapshotChange[] = [];
    for (const f of old) {
      const current = now.find((x) => x.id === f.id);
      if (!current) {
        changes.push({ id: f.id, path: f.path, binary: !!f.binary, status: "removed" });
        continue;
      }
      const before = Buffer.from(f.state, "base64");
      const same = f.binary
        ? Buffer.compare(before, Buffer.from(current.state)) === 0
        : decodeText(before) === decodeText(current.state);
      if (!same || current.path !== f.path)
        changes.push({
          id: f.id,
          path: current.path,
          oldPath: current.path === f.path ? undefined : f.path,
          binary: current.binary,
          status: same ? "renamed" : "changed",
        });
    }
    for (const f of now)
      if (!old.some((x) => x.id === f.id))
        changes.push({ id: f.id, path: f.path, binary: f.binary, status: "added" });
    return changes;
  }),
  route<InProject>(
    "GET",
    /^snapshots\/([^/]+)\/files\/([^/]+)$/,
    async (ctx, [id = "", file = ""]) => {
      const f =
        (await savedFiles(ctx, id)).find((x) => x.id === file) ?? fail(404, "该版本不含此文档");
      if (f.binary) fail(400, "二进制文件不能逐行对比");
      return { path: f.path, content: decodeText(Buffer.from(f.state, "base64")) };
    },
  ),
  route<InProject>("POST", /^snapshots\/([^/]+)\/restore$/, async (ctx, [id = ""]) => {
    await ctx.need("owner");
    const body = await ctx.body(),
      fileId = str(body, "file"),
      expected = str(body, "expected", 2_000_000);
    const old =
      (await savedFiles(ctx, id)).find((f) => f.id === fileId && !f.binary) ??
      fail(404, "该版本不含此文档");
    const current = await ctx.store.fileMeta(ctx.project, fileId);
    if (current.binary) fail(400, "只支持恢复文本");
    await ctx.store.snapshot(ctx.project, ctx.user.id, "恢复文档前");
    await ctx.collab.replace(
      ctx.project,
      fileId,
      expected,
      decodeText(Buffer.from(old.state, "base64")),
      ctx.user.id,
    );
    return { ok: true };
  }),
];
