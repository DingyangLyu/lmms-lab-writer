/** Source comments anchored with Yjs relative positions, with replies and resolution. */
import * as Y from "yjs";
import type { Comment, Reply } from "../../shared/api";
import { sql } from "../db";
import { created, type InProject, route, str } from "../http";
import { fail, uid } from "../util";

const comment = async (ctx: InProject, id: string) => {
  await ctx.need("comment");
  return (
    (await ctx.store.db.row<{ id: string; author: string }>(
      sql`SELECT id, author FROM comments WHERE project=${ctx.project} AND id=${id}`,
    )) ?? fail(404, "批注不存在")
  );
};

export const commentRoutes = [
  route<InProject>("GET", /^comments$/, async (ctx): Promise<Comment[]> => {
    const { db } = ctx.store;
    const comments = await db.rows<Omit<Comment, "replies">>(
      sql`SELECT c.id, c.file, c.author, u.username AS "authorName", c.quote, c.start_pos AS start,
                 c.end_pos AS "end", c.body, c.resolved, c.created, c.updated
          FROM comments c JOIN users u ON c.author=u.id
          WHERE c.project=${ctx.project} ORDER BY c.created DESC`,
    );
    const replies = await db.rows<Reply>(
      sql`SELECT r.id, r.comment, r.author, u.username AS "authorName", r.body, r.created
          FROM replies r JOIN comments c ON r.comment=c.id JOIN users u ON r.author=u.id
          WHERE c.project=${ctx.project} ORDER BY r.created`,
    );
    return comments.map((c) => ({ ...c, replies: replies.filter((r) => r.comment === c.id) }));
  }),
  route<InProject>("POST", /^comments$/, async (ctx) => {
    await ctx.need("comment");
    const { store, project } = ctx,
      b = await ctx.body(),
      file = await store.file(project, str(b, "file")),
      start = str(b, "start", 10000),
      end = str(b, "end", 10000),
      quote = str(b, "quote", 20000);
    if (file.binary) fail(400, "请选择源码段落批注");
    const d = new Y.Doc();
    Y.applyUpdate(d, file.state);
    const selectedText = d.getText("content");
    try {
      const a = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(Buffer.from(start, "base64")),
          d,
        ),
        z = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(Buffer.from(end, "base64")),
          d,
        );
      if (!a || !z || a.type !== selectedText || z.type !== a.type || a.index >= z.index)
        fail(409, "选区已失效，请重新选择");
      if (selectedText.toString().slice(a.index, z.index) !== quote)
        fail(409, "选文已被修改，请核对后重新批注");
    } finally {
      d.destroy();
    }
    const id = uid(),
      text = str(b, "body").trim();
    if (!text) fail(400, "批注不能为空");
    await store.db.transaction(async (tx) => {
      await tx.run(
        sql`INSERT INTO comments(id, project, file, author, quote, start_pos, end_pos, body, resolved, created, updated)
            VALUES(${id}, ${project}, ${file.id}, ${ctx.user.id}, ${quote}, ${start}, ${end}, ${text}, false, ${Date.now()}, ${Date.now()})`,
      );
      await store.audit(project, ctx.user.id, "comment.create", { id, file: file.id }, tx);
    });
    ctx.collab.changed(project);
    return created({ id });
  }),
  route<InProject>("POST", /^comments\/([^/]+)\/reply$/, async (ctx, [id = ""]) => {
    const target = await comment(ctx, id),
      text = str(await ctx.body(), "body").trim();
    if (!text) fail(400, "回复不能为空");
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(
        sql`INSERT INTO replies(id, comment, author, body, created)
            VALUES(${uid()}, ${target.id}, ${ctx.user.id}, ${text}, ${Date.now()})`,
      );
      await ctx.store.audit(ctx.project, ctx.user.id, "comment.reply", { id: target.id }, tx);
    });
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
  route<InProject>("PATCH", /^comments\/([^/]+)$/, async (ctx, [id = ""]) => {
    const target = await comment(ctx, id);
    if (target.author !== ctx.user.id && !["owner", "editor"].includes(ctx.role))
      fail(403, "只有作者或编辑者可以更改批注状态");
    const resolved = (await ctx.body()).resolved === true;
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(
        sql`UPDATE comments SET resolved=${resolved}, updated=${Date.now()} WHERE id=${target.id}`,
      );
      await ctx.store.audit(
        ctx.project,
        ctx.user.id,
        resolved ? "comment.resolve" : "comment.reopen",
        { id: target.id },
        tx,
      );
    });
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
];
