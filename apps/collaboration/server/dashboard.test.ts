import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { FileContent, FileInfo, ProjectSummary, TemplateInfo } from "../shared/api";
import { fixture } from "./test-fixture";

const zip = (entries: Record<string, Uint8Array>) =>
  Buffer.from(zipSync(entries)).toString("base64");

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
    const imported = await f.call(
      "/projects/import",
      {
        name: "Uploaded",
        base64: zip({
          "paper/main.tex": strToU8("\\documentclass{article}"),
          "paper/figs/a.png": new Uint8Array([137, 80, 78, 71]),
          "paper/.git/config": strToU8("[core]"),
          "paper/.DS_Store": new Uint8Array([0]),
          "__MACOSX/paper/._main.tex": new Uint8Array([0]),
        }),
      },
      f.owner,
    );
    expect(imported.status).toBe(200);
    expect(imported.data.skipped).toEqual(["paper/.git/config"]);
    const files = (await f.call(`/projects/${imported.data.id}/files`, undefined, f.owner))
      .data as FileInfo[];
    expect(files.map((x) => [x.path, x.binary])).toEqual([
      ["figs/a.png", true],
      ["main.tex", false],
    ]);
    const gbk = await f.call(
      "/projects/import",
      { name: "Old", base64: zip({ "main.tex": new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]) }) },
      f.owner,
    );
    expect(gbk.status).toBe(400);
    expect(gbk.data.error).toContain("main.tex");
    expect(
      (await f.call("/projects/import", { name: "Bad", base64: "bm90IGEgemlw" }, f.owner)).status,
    ).toBe(400);
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
