/**
 * Zotero: a member connects their account with an API key, then imports a library or
 * collection into a .bib file, or links a .bib file to it and updates it from Zotero later.
 */
import type {
  ZoteroAccount,
  ZoteroCollection,
  ZoteroLibrary,
  ZoteroLink,
  ZoteroSync,
} from "../../shared/api";
import { sql } from "../db";
import { type Authed, type InProject, route, str } from "../http";
import { fail, safePath } from "../util";
import {
  collectionKey,
  libraryId,
  zoteroBibtex,
  zoteroCollections,
  zoteroKey,
  zoteroLibraries,
} from "../zotero";
import { createFile } from "./files";

const HEADER =
  "% Kept up to date from Zotero by Writer: edits here are replaced the next time it is updated.\n";
type Account = { api_key: string; zotero_user: string; username: string };
async function account(ctx: Authed, user = ctx.user.id) {
  return ctx.store.db.row<Account>(
    sql`SELECT api_key, zotero_user, username FROM zotero_accounts WHERE user_id=${user}`,
  );
}
const connected = async (ctx: Authed) => (await account(ctx)) ?? fail(400, "请先连接 Zotero");
/** Optional collection: absent or "" means the whole library. */
const collectionOf = (body: Record<string, unknown>) =>
  typeof body.collection === "string" && body.collection ? collectionKey(body.collection) : null;
const label = (body: Record<string, unknown>, key: string) =>
  typeof body[key] === "string" ? (body[key] as string).slice(0, 200) : "";

/** Writes Zotero's export into the linked file (a version first), unless it is unchanged. */
async function write(ctx: InProject, file: string, bibtex: string) {
  const current = await ctx.collab.text(ctx.project, file);
  if (current === bibtex) return false;
  await ctx.store.snapshot(ctx.project, ctx.user.id, "Zotero 更新前");
  await ctx.collab.replace(ctx.project, file, current, bibtex, ctx.user.id);
  return true;
}

export const zoteroAccountRoutes = [
  route<Authed>("GET", /^\/api\/me\/zotero$/, async (ctx): Promise<ZoteroAccount> => {
    const found = await account(ctx);
    return { username: found?.username ?? null };
  }),
  route<Authed>("POST", /^\/api\/me\/zotero$/, async (ctx): Promise<ZoteroAccount> => {
    const key = str(await ctx.body(), "key", 100).trim();
    if (!/^[A-Za-z0-9]{8,64}$/.test(key)) fail(400, "无效的 Zotero 密钥");
    const who = await zoteroKey(ctx.zotero, key);
    await ctx.store.db.run(
      sql`INSERT INTO zotero_accounts(user_id, api_key, zotero_user, username, created)
          VALUES(${ctx.user.id}, ${key}, ${who.userID}, ${who.username}, ${Date.now()})
          ON CONFLICT (user_id) DO UPDATE SET api_key=excluded.api_key,
            zotero_user=excluded.zotero_user, username=excluded.username`,
    );
    return { username: who.username };
  }),
  route<Authed>("POST", /^\/api\/me\/zotero\/remove$/, async (ctx) => {
    await ctx.store.db.run(sql`DELETE FROM zotero_accounts WHERE user_id=${ctx.user.id}`);
    return { ok: true };
  }),
  route<Authed>("GET", /^\/api\/me\/zotero\/libraries$/, async (ctx): Promise<ZoteroLibrary[]> => {
    const found = await connected(ctx);
    return zoteroLibraries(ctx.zotero, found.api_key, found.zotero_user);
  }),
  route<Authed>(
    "GET",
    /^\/api\/me\/zotero\/collections$/,
    async (ctx): Promise<ZoteroCollection[]> => {
      const found = await connected(ctx);
      return zoteroCollections(
        ctx.zotero,
        found.api_key,
        libraryId(ctx.url.searchParams.get("library") ?? ""),
      );
    },
  ),
];

export const zoteroRoutes = [
  route<InProject>("GET", /^zotero$/, async (ctx): Promise<ZoteroLink[]> => {
    const rows = await ctx.store.db.rows<ZoteroLink & { ownerConnected: boolean | null }>(
      sql`SELECT l.file, f.path, l.library, l.library_name AS "libraryName", l.collection,
                 l.collection_name AS "collectionName", l.items, l.synced, l.user_id AS owner,
                 u.username AS "ownerName", (a.user_id IS NOT NULL) AS "ownerConnected"
          FROM zotero_links l JOIN files f ON f.id=l.file JOIN users u ON u.id=l.user_id
          LEFT JOIN zotero_accounts a ON a.user_id=l.user_id
          WHERE l.project=${ctx.project} AND NOT f.deleted ORDER BY f.path`,
    );
    return rows.map((r) => ({ ...r, ownerConnected: !!r.ownerConnected }));
  }),
  // A library or collection as BibTeX, for importing its new entries into an existing file.
  route<InProject>("POST", /^zotero\/export$/, async (ctx) => {
    await ctx.need("edit");
    const body = await ctx.body(),
      found = await connected(ctx);
    return zoteroBibtex(
      ctx.zotero,
      found.api_key,
      libraryId(str(body, "library", 40)),
      collectionOf(body),
    );
  }),
  // Links a .bib file (made if missing) to a library or collection and fills it from Zotero.
  route<InProject>("POST", /^zotero\/link$/, async (ctx): Promise<ZoteroSync> => {
    await ctx.need("edit");
    const body = await ctx.body(),
      found = await connected(ctx),
      library = libraryId(str(body, "library", 40)),
      collection = collectionOf(body),
      path = safePath(str(body, "path", 240));
    if (!path.endsWith(".bib")) fail(400, "请选择 BibTeX 文件");
    const { bibtex, items } = await zoteroBibtex(
      ctx.zotero,
      found.api_key,
      library,
      collection,
      HEADER,
    );
    const existing = await ctx.store.db.row<{ id: string; binary: boolean }>(
      sql`SELECT id, is_binary AS "binary" FROM files
          WHERE project=${ctx.project} AND path=${path} AND NOT deleted`,
    );
    if (existing?.binary) fail(400, "请选择 BibTeX 文件");
    let file: string,
      changed = true;
    if (existing) {
      file = existing.id;
      changed = await write(ctx, file, bibtex);
    } else {
      file = (await createFile(ctx.store, ctx.project, ctx.user.id, path, bibtex)).id;
      ctx.collab.changed(ctx.project);
    }
    await ctx.store.db.run(
      sql`INSERT INTO zotero_links(file, project, user_id, library, library_name, collection,
            collection_name, items, synced)
          VALUES(${file}, ${ctx.project}, ${ctx.user.id}, ${library}, ${label(body, "libraryName")},
            ${collection}, ${collection ? label(body, "collectionName") : null}, ${items}, ${Date.now()})
          ON CONFLICT (file) DO UPDATE SET user_id=excluded.user_id, library=excluded.library,
            library_name=excluded.library_name, collection=excluded.collection,
            collection_name=excluded.collection_name, items=excluded.items, synced=excluded.synced`,
    );
    return { file, path, items, changed };
  }),
  // Updates a linked file with the key of the member who linked it.
  route<InProject>("POST", /^zotero\/refresh$/, async (ctx): Promise<ZoteroSync> => {
    await ctx.need("edit");
    const file = str(await ctx.body(), "file", 100);
    const link =
      (await ctx.store.db.row<{
        path: string;
        user_id: string;
        library: string;
        collection: string | null;
      }>(
        sql`SELECT f.path, l.user_id, l.library, l.collection FROM zotero_links l
            JOIN files f ON f.id=l.file
            WHERE l.file=${file} AND l.project=${ctx.project} AND NOT f.deleted`,
      )) ?? fail(404, "这个文件没有关联 Zotero");
    const owner =
      (await account(ctx, link.user_id)) ??
      fail(400, "关联这个文件的成员已断开 Zotero，请重新关联");
    const { bibtex, items } = await zoteroBibtex(
      ctx.zotero,
      owner.api_key,
      link.library,
      link.collection,
      HEADER,
    );
    const changed = await write(ctx, file, bibtex);
    await ctx.store.db.run(
      sql`UPDATE zotero_links SET items=${items}, synced=${Date.now()} WHERE file=${file}`,
    );
    return { file, path: link.path, items, changed };
  }),
  route<InProject>("POST", /^zotero\/unlink$/, async (ctx) => {
    await ctx.need("edit");
    await ctx.store.db.run(
      sql`DELETE FROM zotero_links WHERE file=${str(await ctx.body(), "file", 100)}
          AND project=${ctx.project}`,
    );
    return { ok: true };
  }),
];
