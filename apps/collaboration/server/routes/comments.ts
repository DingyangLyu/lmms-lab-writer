/**
 * Comment threads anchored to source text with Yjs relative positions, so they follow edits.
 * A comment comes from a selection in the editor (relative positions), or from offsets (a
 * selection on the PDF mapped to its source, or the desktop app), and may keep where on the
 * PDF it was made. Authors edit and delete their own words; owners may delete any comment.
 * Writing @name tells that member (their inbox); a reply tells the others in the thread; and
 * handing comments to an AI conversation is recorded for everyone to see.
 */
import * as Y from "yjs";
import type { Comment, CommentPdf, Handoff, Reply } from "../../shared/api";
import { type Sql, sql } from "../db";
import { type Body, created, type InProject, number, route, str } from "../http";
import { fail, uid } from "../util";

type Row = Omit<Comment, "replies" | "from" | "to" | "line" | "excerpt" | "pdf" | "handoffs"> & {
  pdf: string | null;
};

const thread = async (ctx: InProject, id: string) => {
  await ctx.need("comment");
  return (
    (await ctx.store.db.row<{ id: string; author: string; quote: string }>(
      sql`SELECT id, author, quote FROM comments WHERE project=${ctx.project} AND id=${id}`,
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
/** The id the page chose, so it can show the comment before the server answers. */
const chosenId = (body: Body) => {
  const value = body.id;
  if (value === undefined) return uid();
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) fail(400, "无效的编号");
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

/** A comment as the page shows it: its anchor resolved against the file's current text. */
function present(
  { pdf, ...c }: Row,
  doc: Y.Doc | null,
  replies: Reply[],
  handoffs: Handoff[],
): Comment {
  const a = doc && absolute(doc, c.start),
    z = doc && absolute(doc, c.end);
  const live = !!a && !!z && a.index < z.index;
  const content = live && doc ? doc.getText("content").toString() : "";
  return {
    ...c,
    from: live && a ? a.index : null,
    to: live && z ? z.index : null,
    line: live && a ? content.slice(0, a.index).split("\n").length : null,
    excerpt: live && a && z ? content.slice(a.index, z.index).slice(0, 4000) : null,
    pdf: pdf ? (JSON.parse(pdf) as CommentPdf) : null,
    replies,
    handoffs,
  };
}

/** Members named with @ in `body` (longest names first, so "@Ann Lee" is not "@Ann"). */
async function mentioned(db: Sql, project: string, body: string) {
  if (!body.includes("@")) return [];
  const members = await db.rows<{ id: string; username: string }>(
    sql`SELECT u.id, u.username FROM members m JOIN users u ON u.id=m.user_id
        WHERE m.project=${project} AND NOT u.deleted`,
  );
  const found = new Set<string>();
  let rest = body;
  for (const m of members.sort((a, b) => b.username.length - a.username.length)) {
    const name = `@${m.username}`;
    let at = rest.indexOf(name);
    while (at >= 0) {
      const next = rest[at + name.length] ?? "";
      if (!/[\p{L}\p{N}_.-]/u.test(next)) {
        found.add(m.id);
        rest = rest.slice(0, at) + " ".repeat(name.length) + rest.slice(at + name.length);
      }
      at = rest.indexOf(name, at + 1);
    }
  }
  return [...found];
}

/** Puts a notice in each member's inbox (never the actor's own). */
async function tell(
  db: Sql,
  to: string[],
  notice: {
    kind: "mention" | "reply";
    project: string;
    comment: string;
    actor: string;
    body: string;
  },
) {
  const now = Date.now();
  for (const user of new Set(to)) {
    if (user === notice.actor) continue;
    await db.run(
      sql`INSERT INTO notifications(id, user_id, project, comment, actor, kind, body, created)
          VALUES(${uid()}, ${user}, ${notice.project}, ${notice.comment}, ${notice.actor},
                 ${notice.kind}, ${notice.body.slice(0, 2000)}, ${now})`,
    );
  }
  return [...new Set(to)].filter((user) => user !== notice.actor);
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
    const handoffs = await db.rows<Handoff & { comment: string }>(
      sql`SELECT h.comment, h.actor, u.username AS "actorName", h.target, h.created
          FROM comment_handoffs h JOIN comments c ON h.comment=c.id JOIN users u ON h.actor=u.id
          WHERE c.project=${ctx.project} ORDER BY h.created`,
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
      for (const row of rows)
        result.push(
          present(
            row,
            await docOf(row.file),
            replies.filter((r) => r.comment === row.id),
            handoffs.filter((h) => h.comment === row.id).map(({ comment: _, ...h }) => h),
          ),
        );
      return result;
    } finally {
      for (const doc of docs.values()) doc?.destroy();
    }
  }),
  route<InProject>("POST", /^comments$/, async (ctx) => {
    await ctx.need("comment");
    const { store, project } = ctx,
      b = await ctx.body(),
      id = chosenId(b),
      file = await store.file(project, str(b, "file")),
      body = text(b, "body"),
      pdf = pdfOrigin(b.pdf);
    if (file.binary) fail(400, "请选择源码段落批注");
    const d = new Y.Doc();
    let start = "",
      end = "",
      quote = "",
      comment: Comment | null = null;
    const now = Date.now();
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
      comment = present(
        {
          id,
          file: file.id,
          author: ctx.user.id,
          authorName: ctx.user.username,
          quote: quote.slice(0, 20000),
          start,
          end,
          body,
          resolved: false,
          created: now,
          updated: now,
          edited: null,
          pdf: pdf ? JSON.stringify(pdf) : null,
        },
        d,
        [],
        [],
      );
    } finally {
      d.destroy();
    }
    let told: string[] = [];
    await store.db.transaction(async (tx) => {
      if (await tx.row(sql`SELECT 1 FROM comments WHERE id=${id}`)) fail(409, "批注已存在");
      await tx.run(
        sql`INSERT INTO comments(id, project, file, author, quote, start_pos, end_pos, body, resolved, created, updated, pdf)
            VALUES(${id}, ${project}, ${file.id}, ${ctx.user.id}, ${quote.slice(0, 20000)}, ${start}, ${end}, ${body}, false, ${now}, ${now}, ${pdf ? JSON.stringify(pdf) : null})`,
      );
      await store.audit(project, ctx.user.id, "comment.create", { id, file: file.id }, tx);
      told = await tell(tx, await mentioned(tx, project, body), {
        kind: "mention",
        project,
        comment: id,
        actor: ctx.user.id,
        body,
      });
    });
    ctx.collab.changed(project, "comments");
    ctx.collab.notify(told);
    return created({ id, comment });
  }),
  route<InProject>("POST", /^comments\/([^/]+)\/reply$/, async (ctx, [id = ""]) => {
    const target = await thread(ctx, id),
      b = await ctx.body(),
      body = text(b, "body", true),
      replyId = chosenId(b),
      now = Date.now();
    let told: string[] = [];
    await ctx.store.db.transaction(async (tx) => {
      if (await tx.row(sql`SELECT 1 FROM replies WHERE id=${replyId}`)) fail(409, "回复已存在");
      await tx.run(
        sql`INSERT INTO replies(id, comment, author, body, created)
            VALUES(${replyId}, ${target.id}, ${ctx.user.id}, ${body}, ${now})`,
      );
      await tx.run(sql`UPDATE comments SET updated=${now} WHERE id=${target.id}`);
      await ctx.store.audit(ctx.project, ctx.user.id, "comment.reply", { id: target.id }, tx);
      const named = await mentioned(tx, ctx.project, body);
      const notice = { project: ctx.project, comment: target.id, actor: ctx.user.id, body };
      told = await tell(tx, named, { ...notice, kind: "mention" });
      // Everyone else in the thread hears of the reply, once.
      const others = await tx.rows<{ author: string }>(
        sql`SELECT author FROM replies WHERE comment=${target.id}
            UNION SELECT author FROM comments WHERE id=${target.id}`,
      );
      told.push(
        ...(await tell(
          tx,
          others.map((o) => o.author).filter((user) => !named.includes(user)),
          { ...notice, kind: "reply" },
        )),
      );
    });
    ctx.collab.changed(ctx.project, "comments");
    ctx.collab.notify(told);
    const reply: Reply = {
      id: replyId,
      comment: target.id,
      author: ctx.user.id,
      authorName: ctx.user.username,
      body,
      created: now,
      edited: null,
    };
    return { ok: true, reply };
  }),
  // Comments handed to an AI conversation, so everyone sees where they went.
  route<InProject>("POST", /^comments\/handoff$/, async (ctx) => {
    await ctx.need("edit");
    const b = await ctx.body(),
      target = str(b, "target", 200).trim();
    if (!target) fail(400, "请选择 AI 对话");
    if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 200)
      fail(400, "请选择要交给 AI 的批注");
    const ids = b.ids.filter((id): id is string => typeof id === "string");
    const now = Date.now();
    await ctx.store.db.transaction(async (tx) => {
      for (const id of ids) {
        if (!(await tx.row(sql`SELECT 1 FROM comments WHERE project=${ctx.project} AND id=${id}`)))
          continue;
        await tx.run(
          sql`INSERT INTO comment_handoffs(id, comment, actor, target, created)
              VALUES(${uid()}, ${id}, ${ctx.user.id}, ${target}, ${now})`,
        );
      }
    });
    ctx.collab.changed(ctx.project, "comments");
    return { ok: true };
  }),
  route<InProject>("PATCH", /^comments\/([^/]+)$/, async (ctx, [id = ""]) => {
    const target = await thread(ctx, id),
      b = await ctx.body(),
      now = Date.now();
    let told: string[] = [];
    if (typeof b.body === "string") {
      if (target.author !== ctx.user.id) fail(403, "只有作者可以修改批注内容");
      const body = text(b, "body");
      await ctx.store.db.transaction(async (tx) => {
        const before = await mentioned(
          tx,
          ctx.project,
          (await tx.row<{ body: string }>(sql`SELECT body FROM comments WHERE id=${target.id}`))
            ?.body ?? "",
        );
        await tx.run(
          sql`UPDATE comments SET body=${body}, edited=${now}, updated=${now} WHERE id=${target.id}`,
        );
        await ctx.store.audit(ctx.project, ctx.user.id, "comment.edit", { id: target.id }, tx);
        // Only people newly named hear of it.
        const named = (await mentioned(tx, ctx.project, body)).filter((u) => !before.includes(u));
        told = await tell(tx, named, {
          kind: "mention",
          project: ctx.project,
          comment: target.id,
          actor: ctx.user.id,
          body,
        });
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
    ctx.collab.changed(ctx.project, "comments");
    ctx.collab.notify(told);
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
    ctx.collab.changed(ctx.project, "comments");
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
    ctx.collab.changed(ctx.project, "comments");
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
    ctx.collab.changed(ctx.project, "comments");
    return { ok: true };
  }),
];
