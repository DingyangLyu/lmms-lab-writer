import { request } from "node:http";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { FileContent, FileInfo, ProjectSummary, TemplateInfo } from "../shared/api";
import { readZip } from "./routes/projects";
import { fixture } from "./test-fixture";

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Posts a zip the way the dashboard does: the bytes as the body, the name in the query. */
async function importZip(f: Fixture, name: string, body: Uint8Array) {
  const response = await fetch(
    `${f.app.origin}/api/projects/import?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { Origin: f.app.origin, "Content-Type": "application/zip", Cookie: f.owner },
      body: new Uint8Array(body),
    },
  );
  return { status: response.status, data: await response.json() };
}

describe("project dashboard", () => {
  it("lists built-in templates and creates projects from them", async () => {
    const f = await fixture();
    const templates = (await f.call("/templates", undefined, f.owner)).data as TemplateInfo[];
    expect(templates.map((t) => t.id)).toEqual([
      "blank",
      "article",
      "ctex-article",
      "beamer",
      "thesis",
      "ieee-conference",
    ]);
    const ctex = templates.find((t) => t.id === "ctex-article");
    expect(ctex?.engine).toBe("xelatex");
    expect(ctex?.name.en).toBe("Chinese paper (ctex)");
    const preview = await fetch(`${f.app.origin}/api/templates/article/preview`, {
      headers: { Cookie: f.owner },
    });
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(500);

    const made = await f.call("/projects", { name: "Thesis", template: "thesis" }, f.owner);
    expect(made.status).toBe(201);
    const files = (await f.call(`/projects/${made.data.id}/files`, undefined, f.owner))
      .data as FileInfo[];
    expect(files.map((x) => x.path)).toContain("chapters/introduction.tex");
    const article = (await f.call("/projects", { name: "Article", template: "article" }, f.owner))
      .data as ProjectSummary;
    const figure = (
      (await f.call(`/projects/${article.id}/files`, undefined, f.owner)).data as FileInfo[]
    ).find((x) => x.path === "figures/example.png");
    expect(figure?.binary).toBe(true);
    expect((await f.call("/projects", { name: "x", template: "nope" }, f.owner)).status).toBe(404);
    // A blank project still works without a template.
    expect((await f.call("/projects", { name: "Empty" }, f.owner)).status).toBe(201);
  });

  it("shows owner and last change, and keeps archive and trash per member", async () => {
    const f = await fixture();
    const editor = await f.invite("editor", "coauthor");
    const list = async (cookie: string) =>
      ((await f.call("/projects", undefined, cookie)).data as ProjectSummary[]).find(
        (p) => p.id === f.project,
      );
    const before = await list(f.owner);
    expect(before).toMatchObject({ owner: "owner", archived: false, trashed: false });
    await new Promise((r) => setTimeout(r, 5));
    await f.call(`/projects/${f.project}/files`, { path: "a.tex", content: "x" }, editor);
    expect((await list(f.owner))?.updated).toBeGreaterThan(before?.updated ?? 0);

    await f.call(`/projects/${f.project}/archive`, { archived: true }, f.owner);
    expect(await list(f.owner)).toMatchObject({ archived: true, trashed: false });
    expect(await list(editor)).toMatchObject({ archived: false });
    // Trash and archive exclude each other.
    await f.call(`/projects/${f.project}/trash`, { trashed: true }, f.owner);
    expect(await list(f.owner)).toMatchObject({ archived: false, trashed: true });
    await f.call(`/projects/${f.project}/trash`, { trashed: false }, f.owner);
    expect(await list(f.owner)).toMatchObject({ archived: false, trashed: false });

    // The only owner cannot leave; another member can.
    expect((await f.call(`/projects/${f.project}/leave`, {}, f.owner)).status).toBe(409);
    expect((await f.call(`/projects/${f.project}/leave`, {}, editor)).status).toBe(200);
    expect(await list(editor)).toBeUndefined();
    expect(await list(f.owner)).toBeDefined();
    expect((await f.call(`/projects/${f.project}/files`, undefined, editor)).status).toBe(403);
  });

  it("copies a project with its text and binary files for the member who copies it", async () => {
    const f = await fixture();
    const viewer = await f.invite("viewer", "reader");
    await f.call(
      `/projects/${f.project}/files`,
      { path: "main.tex", content: "论文正文" },
      f.owner,
    );
    await f.call(
      `/projects/${f.project}/files`,
      { path: "fig.png", base64: Buffer.from([1, 2, 3]).toString("base64") },
      f.owner,
    );
    const copy = await f.call(`/projects/${f.project}/copy`, { name: "My copy" }, viewer);
    expect(copy.status).toBe(201);
    expect(copy.data).toMatchObject({ name: "My copy", role: "owner", owner: "reader" });
    const files = (await f.call(`/projects/${copy.data.id}/files`, undefined, viewer))
      .data as FileInfo[];
    const read = async (path: string) =>
      (
        await f.call(
          `/projects/${copy.data.id}/files/${files.find((x) => x.path === path)?.id}`,
          undefined,
          viewer,
        )
      ).data as FileContent;
    expect(await read("main.tex")).toMatchObject({ content: "论文正文" });
    expect(await read("fig.png")).toMatchObject({
      base64: Buffer.from([1, 2, 3]).toString("base64"),
    });
  });

  it("imports a zip, dropping its top folder and hidden entries", async () => {
    const f = await fixture();
    const imported = await importZip(
      f,
      "Uploaded",
      zipSync({
        "paper/main.tex": strToU8("\\documentclass{article}"),
        "paper/figs/a.png": new Uint8Array([137, 80, 78, 71]),
        "paper/.git/config": strToU8("[core]"),
        "paper/.DS_Store": new Uint8Array([0]),
        "__MACOSX/paper/._main.tex": new Uint8Array([0]),
      }),
    );
    expect(imported.status).toBe(200);
    expect(imported.data.skipped).toEqual(["paper/.git/config"]);
    const files = (await f.call(`/projects/${imported.data.id}/files`, undefined, f.owner))
      .data as FileInfo[];
    expect(files.map((x) => [x.path, x.binary])).toEqual([
      ["figs/a.png", true],
      ["main.tex", false],
    ]);
    const gbk = await importZip(
      f,
      "Old",
      zipSync({ "main.tex": new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]) }),
    );
    expect(gbk.status).toBe(400);
    expect(gbk.data.error).toContain("main.tex");
    expect((await importZip(f, "Bad", strToU8("not a zip"))).status).toBe(400);
    // Nothing of a failed import is left behind.
    const names = (await f.call("/projects", undefined, f.owner)).data.map(
      (p: ProjectSummary) => p.name,
    );
    expect(names).not.toContain("Old");
  });

  it("checks a zip's sizes before unpacking it, then unpacks it in batches", async () => {
    const f = await fixture();
    const big = await importZip(
      f,
      "Big",
      zipSync({ "main.tex": strToU8("x".repeat(2_100_000)), "a.png": new Uint8Array([1]) }),
    );
    expect(big.status).toBe(413);
    expect(big.data.error).toContain("main.tex");
    expect((await importZip(f, "", zipSync({ "main.tex": strToU8("x") }))).status).toBe(400);

    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 7; i++) files[`fig-${i}.png`] = new Uint8Array(1000).fill(i);
    const { batches } = readZip(zipSync(files), 2500);
    const unpacked = [...batches()];
    expect(unpacked.map((b) => b.length)).toEqual([2, 2, 2, 1]);
    expect(unpacked.flat().map((x) => [x.path, x.data[0]])).toEqual(
      Object.keys(files).map((path, i) => [path, i]),
    );
  });

  it("refuses an upload declared larger than 500 MB before reading it", async () => {
    const f = await fixture();
    const url = new URL(`${f.app.origin}/api/projects/import?name=Huge`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url, {
        method: "POST",
        headers: {
          Origin: f.app.origin,
          Cookie: f.owner,
          "Content-Type": "application/zip",
          "Content-Length": "600000000",
        },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  it("names the exported zip after the project", async () => {
    const f = await fixture();
    await f.call(`/projects/${f.project}`, { name: "量子 论文" }, f.owner, "PATCH");
    const response = await fetch(`${f.app.origin}/api/projects/${f.project}/export`, {
      headers: { Cookie: f.owner },
    });
    expect(response.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent("量子 论文.zip")}`,
    );
  });
});
