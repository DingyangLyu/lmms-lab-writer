/**
 * Each member's inbox: where someone named them with @ in a comment, and replies in threads
 * they take part in. Notices of projects they have left are not shown.
 */
import type { Inbox, Notice } from "../../shared/api";
import { sql } from "../db";
import { type Authed, route } from "../http";

/** The newest notices kept on show; older ones stay in the database. */
const SHOWN = 100;

export const notificationRoutes = [
  route<Authed>("GET", /^\/api\/notifications$/, async (ctx): Promise<Inbox> => {
    const { db } = ctx.store;
    const items = await db.rows<Notice>(
      sql`SELECT n.id, n.kind, n.project, p.name AS "projectName", n.comment, n.actor,
                 u.username AS "actorName", n.body, coalesce(c.quote, '') AS quote, n.created, n.read
          FROM notifications n
          JOIN members m ON m.project=n.project AND m.user_id=n.user_id
          JOIN projects p ON p.id=n.project
          JOIN users u ON u.id=n.actor
          LEFT JOIN comments c ON c.id=n.comment
          WHERE n.user_id=${ctx.user.id}
          ORDER BY n.created DESC LIMIT ${SHOWN}`,
    );
    const unread = await db.row<{ count: number | string }>(
      sql`SELECT count(*) AS count FROM notifications n
          JOIN members m ON m.project=n.project AND m.user_id=n.user_id
          WHERE n.user_id=${ctx.user.id} AND NOT n.read`,
    );
    return {
      items: items.map((n) => ({ ...n, quote: n.quote.slice(0, 300), body: n.body.slice(0, 600) })),
      unread: Number(unread?.count ?? 0),
    };
  }),
  // Marks the notices given (or all of them) as read.
  route<Authed>("POST", /^\/api\/notifications\/read$/, async (ctx) => {
    const body = await ctx.body();
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 500)
      : null;
    if (ids)
      for (const id of ids)
        await ctx.store.db.run(
          sql`UPDATE notifications SET read=true WHERE id=${id} AND user_id=${ctx.user.id}`,
        );
    else
      await ctx.store.db.run(
        sql`UPDATE notifications SET read=true WHERE user_id=${ctx.user.id} AND NOT read`,
      );
    return { ok: true };
  }),
];
