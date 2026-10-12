import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fixture } from "./test-fixture";

const entry = (key: string, title: string) =>
  `@article{${key},\n  title = {${title}},\n  author = {Smith, Ann},\n  year = {2020}\n}`;

/** Zotero's web API with one account (key `goodkey12345`), a group and a few items. */
async function fakeZotero() {
  // More than one page (Zotero gives at most 100 items a request); the second page repeats a
  // key from the first.
  const items = Array.from({ length: 150 }, (_, i) => entry(`paper${i}`, `Paper number ${i}`));
  items[0] = entry("smith2020", "Interfaces in lithium batteries");
  items[120] = entry("smith2020", "A different paper with the same key");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://zotero");
    const send = (status: number, body: unknown, total?: number) => {
      res.writeHead(status, {
        "Content-Type": typeof body === "string" ? "text/plain" : "application/json",
        ...(total === undefined ? {} : { "Total-Results": String(total) }),
      });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.headers["zotero-api-key"] !== "goodkey12345") return send(403, "Invalid key");
    const start = Number(url.searchParams.get("start") ?? 0);
    switch (url.pathname) {
      case "/keys/current":
        return send(200, { userID: 42, username: "lab", access: { user: { library: true } } });
      case "/users/42/groups":
        return send(200, [{ id: 7, data: { name: "Lab group" } }], 1);
      case "/groups/7/collections":
        return send(
          200,
          [
            { key: "BBBB2222", data: { name: "Chapter 2", parentCollection: "AAAA1111" } },
            { key: "AAAA1111", data: { name: "Thesis", parentCollection: false } },
          ],
          2,
        );
      case "/users/42/items/top": {
        expect(url.searchParams.get("format")).toBe("bibtex");
        const limit = Number(url.searchParams.get("limit"));
        return send(200, items.slice(start, start + limit).join("\n\n"), items.length);
      }
      case "/groups/7/collections/BBBB2222/items/top":
        return send(200, entry("kim2019", "Collection item"), 1);
      default:
        return send(404, "Not found");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise((done) => server.close(() => done())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, items };
}
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("Zotero", () => {
  it("connects an account, links a .bib file and lets any editor update it", async () => {
    const zotero = await fakeZotero();
    const f = await fixture({ zoteroApi: zotero.url });
    const editor = await f.invite("editor", "coauthor"),
      viewer = await f.invite("viewer", "reader");
    const p = `/projects/${f.project}`;

    expect((await f.call("/me/zotero", undefined, f.owner)).data).toEqual({ username: null });
    expect((await f.call("/me/zotero", { key: "not a key" }, f.owner)).status).toBe(400);
    expect((await f.call("/me/zotero", { key: "wrongkey1234" }, f.owner)).status).toBe(403);
    expect((await f.call("/me/zotero", { key: "goodkey12345" }, f.owner)).data).toEqual({
      username: "lab",
    });
    expect((await f.call("/me/zotero/libraries", undefined, f.owner)).data).toEqual([
      { id: "users/42", name: "" },
      { id: "groups/7", name: "Lab group" },
    ]);
    expect(
      (await f.call("/me/zotero/collections?library=groups/7", undefined, f.owner)).data,
    ).toEqual([
      { key: "AAAA1111", name: "Thesis" },
      { key: "BBBB2222", name: "Thesis / Chapter 2" },
    ]);
    const exported = await f.call(
      `${p}/zotero/export`,
      { library: "groups/7", collection: "BBBB2222" },
      f.owner,
    );
    expect(exported.data).toMatchObject({ items: 1 });
    expect(exported.data.bibtex).toContain("@article{kim2019,");

    // Without an account of their own, the editor cannot link but can update the owner's link.
    expect(
      (await f.call(`${p}/zotero/link`, { library: "users/42", path: "z.bib" }, editor)).status,
    ).toBe(400);
    const linked = await f.call(
      `${p}/zotero/link`,
      { library: "users/42", libraryName: "", path: "refs/zotero.bib" },
      f.owner,
    );
    expect(linked.data).toMatchObject({ path: "refs/zotero.bib", items: 150, changed: true });
    const file = linked.data.file as string;
    const content = async () =>
      (await f.call(`${p}/files/${file}`, undefined, f.owner)).data.content as string;
    const first = await content();
    expect(first).toMatch(/^% Kept up to date from Zotero/);
    expect(first).toContain("@article{smith2020,");
    expect(first).toContain("@article{paper149,");
    expect(first).toContain("@article{smith2020_2,");

    const links = (await f.call(`${p}/zotero`, undefined, viewer)).data;
    expect(links).toEqual([
      expect.objectContaining({
        file,
        path: "refs/zotero.bib",
        library: "users/42",
        items: 150,
        ownerName: "owner",
        ownerConnected: true,
      }),
    ]);
    expect((await f.call(`${p}/zotero/refresh`, { file }, viewer)).status).toBe(403);

    expect((await f.call(`${p}/zotero/refresh`, { file }, editor)).data).toMatchObject({
      changed: false,
    });
    zotero.items.push(entry("park2022", "A new paper"));
    expect((await f.call(`${p}/zotero/refresh`, { file }, editor)).data).toMatchObject({
      items: 151,
      changed: true,
    });
    const second = await content();
    expect(second).toContain("@article{park2022,");
    // The keys Zotero gave before stay as they were.
    expect(second.indexOf("@article{smith2020_2,")).toBeGreaterThan(0);
    const versions = (await f.call(`${p}/snapshots`, undefined, f.owner)).data as Array<{
      label: string;
    }>;
    expect(versions.map((v) => v.label)).toContain("Zotero 更新前");

    await f.call("/me/zotero/remove", {}, f.owner);
    const orphan = await f.call(`${p}/zotero/refresh`, { file }, editor);
    expect(orphan.status).toBe(400);
    expect((await f.call(`${p}/zotero`, undefined, f.owner)).data[0].ownerConnected).toBe(false);
    await f.call(`${p}/zotero/unlink`, { file }, editor);
    expect((await f.call(`${p}/zotero`, undefined, f.owner)).data).toEqual([]);
  });
});
