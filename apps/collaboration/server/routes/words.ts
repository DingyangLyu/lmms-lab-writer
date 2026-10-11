/**
 * Each member's spelling dictionary: the words they added from the editor, kept with the
 * account so every browser and computer they sign in on knows them.
 */
import { sql } from "../db";
import { type Authed, route, str } from "../http";
import { fail } from "../util";

/** Enough for a field's jargon and names; a word is a word, not a sentence. */
const MOST = 5000,
  LONGEST = 64;
const word = (body: Record<string, unknown>) => {
  const value = str(body, "word", 200).trim();
  if (!value || value.length > LONGEST || /\s/.test(value)) fail(400, "无效的单词");
  return value;
};

export const wordRoutes = [
  route<Authed>(
    "GET",
    /^\/api\/me\/words$/,
    async (ctx): Promise<string[]> =>
      (
        await ctx.store.db.rows<{ word: string }>(
          sql`SELECT word FROM user_words WHERE user_id=${ctx.user.id} ORDER BY lower(word), word`,
        )
      ).map((r) => r.word),
  ),
  // Adds one word, or several (`words`, e.g. those a browser kept before).
  route<Authed>("POST", /^\/api\/me\/words$/, async (ctx) => {
    const body = await ctx.body();
    const words = Array.isArray(body.words)
      ? body.words.slice(0, MOST).map((w) => word({ word: w }))
      : [word(body)];
    const { count } = (await ctx.store.db.row<{ count: number | string }>(
      sql`SELECT count(*) AS count FROM user_words WHERE user_id=${ctx.user.id}`,
    )) ?? { count: 0 };
    if (Number(count) + words.length > MOST) fail(400, "个人词典已满");
    const now = Date.now();
    await ctx.store.db.transaction(async (tx) => {
      for (const w of words)
        await tx.run(
          sql`INSERT INTO user_words(user_id, word, created) VALUES(${ctx.user.id}, ${w}, ${now})
              ON CONFLICT DO NOTHING`,
        );
    });
    return { ok: true };
  }),
  route<Authed>("POST", /^\/api\/me\/words\/remove$/, async (ctx) => {
    await ctx.store.db.run(
      sql`DELETE FROM user_words WHERE user_id=${ctx.user.id} AND word=${word(await ctx.body())}`,
    );
    return { ok: true };
  }),
];
