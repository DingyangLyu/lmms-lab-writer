/**
 * Comment threads anchored to source text with Yjs relative positions, so they follow edits.
 * A comment comes from a selection in the editor (relative positions), or from offsets (a
 * selection on the PDF mapped to its source, or the desktop app), and may keep where on the
 * PDF it was made. Authors edit and delete their own words; owners may delete any comment.
 */
import * as Y from "yjs";
import type { Comment, CommentPdf, Reply } from "../../shared/api";
import { sql } from "../db";
import { type Body, created, type InProject, number, route, str } from "../http";
import { fail, uid } from "../util";

type Row = Omit<Comment, "replies" | "from" | "to" | "line" | "pdf"> & { pdf: string | null };

const thread = async (ctx: InProject, id: string) => {
  await ctx.need("comment");
  return (
    (await ctx.store.db.row<{ id: string; author: string }>(
      sql`SELECT id, author FROM comments WHERE project=${ctx.project} AND id=${id}`,
    )) ?? fail(404, "批注不存在")
  );
};
const replyOf = async (ctx: InProject, id: string) => {
  await ctx.need("comment");
  return (
    (await ctx.store.db.row<{ id: string; author: string; comment: string }>(
      sql`SELECT r.id, r.author, r.comment FROM replies r JOIN comments c ON r.comment=c.id
          WHERE c.project=${ctx.project} AND r.id=${id}`,
    )) ?? fail(404, "回复不存在")
  );
};
const text = (body: Body, key: string, reply = false) => {
  const value = str(body, key).trim();
  if (!value) fail(400, reply ? "回复不能为空" : "批注不能为空");
  return value;
};
const encode = (position: Y.RelativePosition) =>
  Buffer.from(Y.encodeRelativePosition(position)).toString("base64");
const absolute = (doc: Y.Doc, encoded: string) => {
  try {
    return Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(encoded, "base64")),
      doc,
    );
  } catch {
    return null;
  }
};

/** Where a PDF selection lay: style and page rectangles, checked like the desktop's marks. */
function pdfOrigin(value: unknown): CommentPdf | null {
  if (value === undefined || value === null) return null;
  const v = value as Partial<CommentPdf>;
  const unit = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1.01;
  if (
    typeof v.fingerprint !== "string" ||
    v.fingerprint.length > 200 ||
    (v.style !== "highlight" && v.style !== "underline") ||
    !Array.isArray(v.marks) ||
    !v.marks.length ||
    v.marks.length > 200 ||
    !v.marks.every(
      (m) =>
        Number.isSafeInteger(m?.page) &&
        m.page > 0 &&
        unit(m.x) &&
        unit(m.y) &&
        unit(m.width) &&
        unit(m.height),
    )
  )
    fail(400, "无效的 PDF 选区坐标");
  return {
    fingerprint: v.fingerprint,
    style: v.style,
    marks: v.marks.map(({ page, x, y, width, height }) => ({ page, x, y, width, height })),
  };
}

export const commentRoutes = [
  route<InProject>("GET", /^comments$/, async (ctx): Promise<Comment[]> => {
    const { db } = ctx.store;
    const rows = await db.rows<Row>(
      sql`SELECT c.id, c.file, c.author, u.username AS "authorName", c.quote, c.start_pos AS start,
                 c.end_pos AS "end", c.body, c.resolved, c.created, c.updated, c.edited, c.pdf
          FROM comments c JOIN users u ON c.author=u.id
          WHERE c.project=${ctx.project} ORDER BY c.created DESC`,
    );
    const replies = await db.rows<Reply>(
      sql`SELECT r.id, r.comment, r.author, u.username AS "authorName", r.body, r.created, r.edited
          FROM replies r JOIN comments c ON r.comment=c.id JOIN users u ON r.author=u.id
          WHERE c.project=${ctx.project} ORDER BY r.created`,
    );
    // Resolve every anchor against the current text, once per file.
    const docs = new Map<string, Y.Doc | null>();
    const docOf = async (file: string) => {
      if (!docs.has(file)) {
        const ok = await ctx.store.fileExists(ctx.project, file);
        const doc = ok ? new Y.Doc() : null;
        if (doc) Y.applyUpdate(doc, await ctx.store.fileState(file));
        docs.set(file, doc);
      }
      return docs.get(file) ?? null;
    };
    try {
      const result: Comment[] = [];
      for (const { pdf, ...c } of rows) {
        const doc = await docOf(c.file);
        const a = doc && absolute(doc, c.start),
          z = doc && absolute(doc, c.end);
        const live = !!a && !!z && a.index < z.index;
        const content = live && doc ? doc.getText("content").toString() : "";
        result.push({
          ...c,
          from: live && a ? a.index : null,
          to: live && z ? z.index : null,
          line: live && a ? content.slice(0, a.index).split("\n").length : null,
          pdf: pdf ? (JSON.parse(pdf) as CommentPdf) : null,
          replies: replies.filter((r) => r.comment === c.id),
        });
      }
      return result;
    } finally {
      for (const doc of docs.values()) doc?.destroy();
    }
  }),
  route<InProject>("POST", /^comments$/, async (ctx) => {
    await ctx.need("comment");
    const { store, project } = ctx,
      b = await ctx.body(),
      file = await store.file(project, str(b, "file")),
      body = text(b, "body"),
      pdf = pdfOrigin(b.pdf);
    if (file.binary) fail(400, "请选择源码段落批注");
    const d = new Y.Doc();
    let start = "",
      end = "",
      quote = "";
    try {
      Y.applyUpdate(d, file.state);
      const content = d.getText("content");
      if (b.from !== undefined) {
        // Offsets from a mapped PDF selection or the desktop app, with the text they expect there.
        const from = number(b, "from"),
          to = number(b, "to"),
          excerpt = str(b, "excerpt", 200_000);
        if (from < 0 || to > content.length || from >= to) fail(409, "选区已失效，请重新选择");
        if (content.toString().slice(from, to) !== excerpt)
          fail(409, "选文已被修改，请核对后重新批注");
        start = encode(Y.createRelativePositionFromTypeIndex(content, from));
        end = encode(Y.createRelativePositionFromTypeIndex(content, to, -1));
        quote = typeof b.quote === "string" && b.quote.trim() ? str(b, "quote", 20000) : excerpt;
      } else {
        start = str(b, "start", 10000);
        end = str(b, "end", 10000);
        quote = str(b, "quote", 20000);
        const a = absolute(d, start),
          z = absolute(d, end);
        if (!a || !z || a.type !== content || z.type !== a.type || a.index >= z.index)
          fail(409, "选区已失效，请重新选择");
        if (content.toString().slice(a.index, z.index) !== quote)
          fail(409, "选文已被修改，请核对后重新批注");
      }
    } finally {
      d.destroy();
    }
    const id = uid(),
      now = Date.now();
    await store.db.transaction(async (tx) => {
      await tx.run(
        sql`INSERT INTO comments(id, project, file, author, quote, start_pos, end_pos, body, resolved, created, updated, pdf)
            VALUES(${id}, ${project}, ${file.id}, ${ctx.user.id}, ${quote.slice(0, 20000)}, ${start}, ${end}, ${body}, false, ${now}, ${now}, ${pdf ? JSON.stringify(pdf) : null})`,
      );
      await store.audit(project, ctx.user.id, "comment.create", { id, file: file.id }, tx);
    });
    ctx.collab.changed(project);
    return created({ id });
  }),
  route<InProject>("POST", /^comments\/([^/]+)\/reply$/, async (ctx, [id = ""]) => {
    const target = await thread(ctx, id),
      body = text(await ctx.body(), "body", true);
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(
        sql`INSERT INTO replies(id, comment, author, body, created)
            VALUES(${uid()}, ${target.id}, ${ctx.user.id}, ${body}, ${Date.now()})`,
      );
      await tx.run(sql`UPDATE comments SET updated=${Date.now()} WHERE id=${target.id}`);
      await ctx.store.audit(ctx.project, ctx.user.id, "comment.reply", { id: target.id }, tx);
    });
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
  route<InProject>("PATCH", /^comments\/([^/]+)$/, async (ctx, [id = ""]) => {
    const target = await thread(ctx, id),
      b = await ctx.body(),
      now = Date.now();
    if (typeof b.body === "string") {
      if (target.author !== ctx.user.id) fail(403, "只有作者可以修改批注内容");
      const body = text(b, "body");
      await ctx.store.db.transaction(async (tx) => {
        await tx.run(
          sql`UPDATE comments SET body=${body}, edited=${now}, updated=${now} WHERE id=${target.id}`,
        );
        await ctx.store.audit(ctx.project, ctx.user.id, "comment.edit", { id: target.id }, tx);
      });
    } else {
      if (target.author !== ctx.user.id && !["owner", "editor"].includes(ctx.role))
        fail(403, "只有作者或编辑者可以更改批注状态");
      const resolved = b.resolved === true;
      await ctx.store.db.transaction(async (tx) => {
        await tx.run(
          sql`UPDATE comments SET resolved=${resolved}, updated=${now} WHERE id=${target.id}`,
        );
        await ctx.store.audit(
          ctx.project,
          ctx.user.id,
          resolved ? "comment.resolve" : "comment.reopen",
          { id: target.id },
          tx,
        );
      });
    }
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
  route<InProject>("DELETE", /^comments\/([^/]+)$/, async (ctx, [id = ""]) => {
    const target = await thread(ctx, id);
    if (target.author !== ctx.user.id && ctx.role !== "owner")
      fail(403, "只有作者或所有者可以删除批注");
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(sql`DELETE FROM comments WHERE id=${target.id}`);
      await ctx.store.audit(ctx.project, ctx.user.id, "comment.delete", { id: target.id }, tx);
    });
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
  route<InProject>("PATCH", /^replies\/([^/]+)$/, async (ctx, [id = ""]) => {
    const target = await replyOf(ctx, id);
    if (target.author !== ctx.user.id) fail(403, "只有作者可以修改回复");
    const body = text(await ctx.body(), "body", true),
      now = Date.now();
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(sql`UPDATE replies SET body=${body}, edited=${now} WHERE id=${target.id}`);
      await tx.run(sql`UPDATE comments SET updated=${now} WHERE id=${target.comment}`);
      await ctx.store.audit(ctx.project, ctx.user.id, "comment.reply.edit", { id: target.id }, tx);
    });
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
  route<InProject>("DELETE", /^replies\/([^/]+)$/, async (ctx, [id = ""]) => {
    const target = await replyOf(ctx, id);
    if (target.author !== ctx.user.id && ctx.role !== "owner")
      fail(403, "只有作者或所有者可以删除回复");
    await ctx.store.db.transaction(async (tx) => {
      await tx.run(sql`DELETE FROM replies WHERE id=${target.id}`);
      await ctx.store.audit(
        ctx.project,
        ctx.user.id,
        "comment.reply.delete",
        { id: target.id },
        tx,
      );
    });
    ctx.collab.changed(ctx.project);
    return { ok: true };
  }),
];
