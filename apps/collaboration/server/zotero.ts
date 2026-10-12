/**
 * Zotero's web API, read only (https://www.zotero.org/support/dev/web_api/v3/start): who a key
 * belongs to, the libraries and collections it can read, and their items as BibTeX.
 */
import { importBibliography } from "@lmms-lab/writing";
import { checked, fail } from "./util";

export const ZOTERO_API = "https://api.zotero.org";
const PAGE = 100;
/** Beyond this a library is better linked by collection: each 100 items is one request. */
export const MOST_ITEMS = 5000;
/** `users/<id>` (a member's own library) or `groups/<id>`. */
export const libraryId = (value: string) =>
  /^(users|groups)\/\d{1,12}$/.test(value) ? value : fail(400, "无效的 Zotero 文库");
export const collectionKey = (value: string) =>
  /^[A-Z0-9]{8}$/.test(value) ? value : fail(400, "无效的 Zotero 分类");

async function call(base: string, key: string, path: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3" },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch {
    fail(502, "连不上 Zotero，请稍后再试");
  }
  if (response.status === 403) fail(403, "Zotero 密钥无效，或没有读取这个文库的权限");
  if (response.status === 404) fail(404, "Zotero 找不到这个文库或分类");
  if (response.status === 429 || response.status === 503) fail(503, "Zotero 暂时繁忙，请稍后再试");
  if (!response.ok) fail(502, "Zotero 请求失败（{status}）", { status: response.status });
  return response;
}
const total = (response: Response) => Number(response.headers.get("Total-Results") ?? 0);
async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    fail(502, "Zotero 返回了无法识别的内容");
  }
}
type Row = {
  key?: string;
  id?: number;
  data?: { name?: string; parentCollection?: string | false };
};
/** Every row of a JSON listing, a page at a time. */
async function listing(base: string, key: string, path: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let start = 0, count = 1; start < count && start < MOST_ITEMS; start += PAGE) {
    const response = await call(base, key, `${path}?limit=${PAGE}&start=${start}`);
    count = total(response);
    const page = await json(response);
    if (!Array.isArray(page)) fail(502, "Zotero 返回了无法识别的内容");
    rows.push(...(page as Row[]));
  }
  return rows;
}

/** The account a key belongs to. */
export async function zoteroKey(base: string, key: string) {
  const data = (await json(await call(base, key, "/keys/current"))) as {
    userID?: number;
    username?: string;
  } | null;
  if (!data?.userID) fail(502, "Zotero 返回了无法识别的内容");
  return { userID: String(data.userID), username: String(data.username || data.userID) };
}

/** The key owner's library (named "") and the groups they belong to. */
export async function zoteroLibraries(base: string, key: string, userID: string) {
  const groups = await listing(base, key, `/users/${userID}/groups`);
  return [
    { id: `users/${userID}`, name: "" },
    ...groups
      .filter((g) => g.id)
      .map((g) => ({ id: `groups/${g.id}`, name: String(g.data?.name || g.id) })),
  ];
}

/** A library's collections, each named with its parents ("Thesis / Chapter 2"). */
export async function zoteroCollections(base: string, key: string, library: string) {
  const rows = (await listing(base, key, `/${libraryId(library)}/collections`)).filter(
    (r) => r.key,
  );
  const byKey = new Map(rows.map((r) => [r.key, r.data ?? {}]));
  const name = (k: string, depth = 0): string => {
    const c = byKey.get(k);
    const parent = c?.parentCollection;
    const own = c?.name || k;
    return parent && byKey.has(parent) && depth < 20 ? `${name(parent, depth + 1)} / ${own}` : own;
  };
  return rows
    .map((r) => ({ key: r.key as string, name: name(r.key as string) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A library's (or one collection's) items as one BibTeX file. Oldest first, so the keys
 * Zotero gives stay put as items are added; keys repeated across pages get a suffix.
 */
export async function zoteroBibtex(
  base: string,
  key: string,
  library: string,
  collection: string | null,
  header = "",
) {
  const path = collection
    ? `/${libraryId(library)}/collections/${collectionKey(collection)}/items/top`
    : `/${libraryId(library)}/items/top`;
  let content = header,
    items = 0;
  for (let start = 0; start === 0 || start < items; start += PAGE) {
    const response = await call(
      base,
      key,
      `${path}?format=bibtex&sort=dateAdded&direction=asc&limit=${PAGE}&start=${start}`,
    );
    items = total(response);
    if (items > MOST_ITEMS)
      fail(413, "Zotero 文库超过 {count} 条，请选择一个分类", { count: MOST_ITEMS });
    const page = await response.text();
    if (page.trim()) content = checked(() => importBibliography(content, page).content);
  }
  return { bibtex: content.trimStart(), items };
}
