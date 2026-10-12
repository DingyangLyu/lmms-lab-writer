import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fixture } from "./test-fixture";

describe("share links, chat and tags", () => {
  it("lets anyone signed in join by link, never lowering a role", async () => {
    const f = await fixture();
    // Someone with an account who is not in the second project.
    const coauthor = await f.invite("editor", "coauthor");
    const other = (await f.call("/projects", { name: "second" }, f.owner)).data.id as string;
    const p = `/projects/${other}`;
    expect((await f.call(`${p}/share-links`, undefined, coauthor)).status).toBe(403);
    expect((await f.call(`${p}/share-links`, undefined, f.owner)).data).toEqual({
      viewer: null,
      editor: null,
    });
    const view = (await f.call(`${p}/share-links`, { role: "viewer", enabled: true }, f.owner)).data
      .viewer as string;
    const token = new URL(view).searchParams.get("share") as string;
    expect(token.length).toBeGreaterThan(20);

    const joined = await f.call("/share/join", { token }, coauthor);
    expect(joined.data).toMatchObject({ id: other, role: "viewer" });
    const edit = (await f.call(`${p}/share-links`, { role: "editor", enabled: true }, f.owner)).data
      .editor as string;
    const editToken = new URL(edit).searchParams.get("share") as string;
    expect((await f.call("/share/join", { token: editToken }, coauthor)).data.role).toBe("editor");
    // Opening the view link again leaves them an editor.
    expect((await f.call("/share/join", { token }, coauthor)).data.role).toBe("editor");

    await f.call(`${p}/share-links`, { role: "viewer", enabled: false }, f.owner);
    expect((await f.call("/share/join", { token }, coauthor)).status).toBe(410);
    expect((await f.call("/share/join", { token: editToken })).status).toBe(401);
  });

  it("keeps a project chat and tells open pages at once", async () => {
    const f = await fixture();
    const reader = await f.invite("viewer", "reader");
    const p = `/projects/${f.project}`;
    const socket = new WebSocket(`${f.app.origin.replace("http:", "ws:")}/api${p}/socket`, {
      headers: { Cookie: reader, Origin: f.app.origin },
    });
    const heard = new Promise<{ type: string; message: { body: string; authorName: string } }>(
      (resolve) =>
        socket.on("message", (data) => {
          const m = JSON.parse(data.toString());
          if (m.type === "chat") resolve(m);
        }),
    );
    await new Promise((r) => socket.on("open", r));
    expect((await f.call(`${p}/chat`, { body: "  " }, f.owner)).status).toBe(400);
    const sent = await f.call(`${p}/chat`, { body: "Draft is ready for review" }, f.owner);
    expect(sent.data).toMatchObject({ authorName: "owner", body: "Draft is ready for review" });
    expect((await heard).message).toMatchObject({ body: "Draft is ready for review" });
    // Viewers chat too.
    await f.call(`${p}/chat`, { body: "Thanks, reading now" }, reader);
    const list = (await f.call(`${p}/chat`, undefined, reader)).data as Array<{ body: string }>;
    expect(list.map((m) => m.body)).toEqual(["Draft is ready for review", "Thanks, reading now"]);
    socket.terminate();
  });

  it("keeps each member's tags to themselves", async () => {
    const f = await fixture();
    const coauthor = await f.invite("editor", "coauthor");
    const p = `/projects/${f.project}`;
    expect(
      (await f.call(`${p}/tags`, { tags: ["Thesis", " thesis  draft ", "Thesis"] }, f.owner, "PUT"))
        .data,
    ).toEqual({
      tags: ["Thesis", "thesis draft"],
    });
    const tags = async (cookie: string) =>
      (
        (await f.call("/projects", undefined, cookie)).data as Array<{ id: string; tags: string[] }>
      ).find((x) => x.id === f.project)?.tags;
    expect(await tags(f.owner)).toEqual(["Thesis", "thesis draft"]);
    expect(await tags(coauthor)).toEqual([]);
    await f.call("/tags/rename", { from: "thesis draft", to: "Thesis" }, f.owner);
    expect(await tags(f.owner)).toEqual(["Thesis"]);
    await f.call("/tags/delete", { tag: "Thesis" }, f.owner);
    expect(await tags(f.owner)).toEqual([]);
    expect((await f.call(`${p}/tags`, { tags: ["x".repeat(41)] }, f.owner, "PUT")).status).toBe(
      400,
    );
  });
});
