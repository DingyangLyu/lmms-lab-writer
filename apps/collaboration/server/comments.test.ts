import { describe, expect, it } from "vitest";
import type { Comment, Inbox } from "../shared/api";
import { fixture } from "./test-fixture";

const TEXT = "\\section{Intro}\nWe measure the barrier.\nIt is low.\n";

async function setup() {
  const f = await fixture();
  const file = (
    await f.call(`/projects/${f.project}/files`, { path: "main.tex", content: TEXT }, f.owner)
  ).data.id as string;
  const list = async (cookie = f.owner) =>
    (await f.call(`/projects/${f.project}/comments`, undefined, cookie)).data as Comment[];
  return { f, file, list };
}

describe("comment threads", () => {
  it("anchors comments made from offsets and reports where they are now", async () => {
    const { f, file, list } = await setup();
    const from = TEXT.indexOf("barrier"),
      to = from + "barrier".length;
    const made = await f.call(
      `/projects/${f.project}/comments`,
      {
        file,
        from,
        to,
        excerpt: "barrier",
        quote: "barrier (from the PDF)",
        body: "Which barrier?",
        pdf: {
          fingerprint: "abc",
          style: "highlight",
          marks: [{ page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
        },
      },
      f.owner,
    );
    expect(made.status).toBe(201);
    let [comment] = await list();
    expect(comment).toMatchObject({
      from,
      to,
      line: 2,
      quote: "barrier (from the PDF)",
      excerpt: "barrier",
      pdf: { fingerprint: "abc", style: "highlight" },
      edited: null,
    });
    // Text inserted before the anchor moves it; the comment stays on "barrier".
    await f.call(
      `/projects/${f.project}/files/${file}`,
      { expected: TEXT, content: `% note\n${TEXT}` },
      f.owner,
      "PUT",
    );
    [comment] = await list();
    expect(comment?.from).toBe(from + "% note\n".length);
    expect(comment?.line).toBe(3);
    // Deleting the anchored words leaves the thread without a position.
    await f.call(
      `/projects/${f.project}/files/${file}`,
      { expected: `% note\n${TEXT}`, content: "% note\n\\section{Intro}\nIt is low.\n" },
      f.owner,
      "PUT",
    );
    [comment] = await list();
    expect(comment?.from).toBeNull();
    expect(comment?.body).toBe("Which barrier?");
  });

  it("refuses offsets that no longer hold the expected text, and bad PDF marks", async () => {
    const { f, file } = await setup();
    const post = (body: object) =>
      f.call(`/projects/${f.project}/comments`, { file, body: "x", ...body }, f.owner);
    expect((await post({ from: 0, to: 4, excerpt: "nope" })).status).toBe(409);
    expect((await post({ from: 5, to: 999, excerpt: "x" })).status).toBe(409);
    expect(
      (
        await post({
          from: 1,
          to: 8,
          excerpt: "section",
          pdf: {
            fingerprint: "a",
            style: "highlight",
            marks: [{ page: 0, x: 0, y: 0, width: 1, height: 1 }],
          },
        })
      ).status,
    ).toBe(400);
  });

  it("lets authors edit and delete their words, owners delete any comment", async () => {
    const { f, file, list } = await setup();
    const editor = await f.invite("editor", "coauthor");
    const commenter = await f.invite("commenter", "reviewer");
    const base = `/projects/${f.project}`;
    await f.call(
      `${base}/comments`,
      { file, from: 1, to: 8, excerpt: "section", body: "Rename?" },
      commenter,
    );
    const [comment] = await list();
    const id = comment?.id ?? "";
    expect(
      (await f.call(`${base}/comments/${id}`, { body: "Hijack" }, editor, "PATCH")).status,
    ).toBe(403);
    expect(
      (await f.call(`${base}/comments/${id}`, { body: "Rename it?" }, commenter, "PATCH")).status,
    ).toBe(200);
    expect((await list())[0]).toMatchObject({ body: "Rename it?" });
    expect((await list())[0]?.edited).toBeTypeOf("number");

    await f.call(`${base}/comments/${id}/reply`, { body: "Agreed." }, editor);
    const reply = (await list())[0]?.replies[0];
    expect(reply).toMatchObject({ body: "Agreed.", authorName: "coauthor", edited: null });
    expect(
      (await f.call(`${base}/replies/${reply?.id}`, { body: "No" }, commenter, "PATCH")).status,
    ).toBe(403);
    expect(
      (await f.call(`${base}/replies/${reply?.id}`, { body: "Agreed!" }, editor, "PATCH")).status,
    ).toBe(200);
    expect((await f.call(`${base}/replies/${reply?.id}`, {}, commenter, "DELETE")).status).toBe(
      403,
    );
    expect((await f.call(`${base}/replies/${reply?.id}`, {}, editor, "DELETE")).status).toBe(200);
    expect((await list())[0]?.replies).toEqual([]);

    expect((await f.call(`${base}/comments/${id}`, {}, editor, "DELETE")).status).toBe(403);
    expect((await f.call(`${base}/comments/${id}`, {}, f.owner, "DELETE")).status).toBe(200);
    expect(await list()).toEqual([]);
  });

  it("takes the page's id, answers with the comment, and tells the members it names", async () => {
    const { f, file, list } = await setup();
    const base = `/projects/${f.project}`;
    const wang = await f.invite("editor", "wang");
    const ann = await f.invite("commenter", "Ann Lee");
    const inbox = async (cookie: string) =>
      (await f.call("/notifications", undefined, cookie)).data as Inbox;
    const made = await f.call(
      `${base}/comments`,
      {
        id: "page-chosen-id-1",
        file,
        from: 1,
        to: 8,
        excerpt: "section",
        body: "@wang and @Ann Lee, please check. @nobody",
      },
      f.owner,
    );
    expect(made.status).toBe(201);
    expect(made.data.comment).toMatchObject({
      id: "page-chosen-id-1",
      line: 1,
      excerpt: "section",
      authorName: "owner",
      replies: [],
      handoffs: [],
    });
    // The same id twice is refused.
    expect(
      (
        await f.call(
          `${base}/comments`,
          { id: "page-chosen-id-1", file, from: 1, to: 8, excerpt: "section", body: "again" },
          f.owner,
        )
      ).status,
    ).toBe(409);
    const named = await inbox(wang);
    expect(named.unread).toBe(1);
    expect(named.items[0]).toMatchObject({
      kind: "mention",
      comment: "page-chosen-id-1",
      actorName: "owner",
      projectName: "test-paper",
      quote: "section",
      read: false,
    });
    expect((await inbox(ann)).unread).toBe(1);
    expect((await inbox(f.owner)).unread).toBe(0);

    // A reply tells the others in the thread (the author), and whoever it names.
    const replied = await f.call(
      `${base}/comments/page-chosen-id-1/reply`,
      { id: "page-chosen-reply-1", body: "Done, @Ann Lee" },
      wang,
    );
    expect(replied.data.reply).toMatchObject({ id: "page-chosen-reply-1", authorName: "wang" });
    expect((await inbox(f.owner)).items[0]).toMatchObject({ kind: "reply", actorName: "wang" });
    expect((await inbox(ann)).items.map((n) => n.kind)).toEqual(["mention", "mention"]);
    expect((await inbox(wang)).unread).toBe(1);

    // Reading one, then all.
    const first = (await inbox(ann)).items[0]?.id;
    await f.call("/notifications/read", { ids: [first] }, ann);
    expect((await inbox(ann)).unread).toBe(1);
    await f.call("/notifications/read", {}, ann);
    expect((await inbox(ann)).unread).toBe(0);

    // Handing comments to an AI conversation is recorded for everyone (editors only).
    expect(
      (
        await f.call(
          `${base}/comments/handoff`,
          { ids: ["page-chosen-id-1"], target: "Codex · 文献" },
          ann,
        )
      ).status,
    ).toBe(403);
    await f.call(
      `${base}/comments/handoff`,
      { ids: ["page-chosen-id-1"], target: "Codex · 文献" },
      wang,
    );
    const [comment] = await list(ann);
    expect(comment?.handoffs).toEqual([
      expect.objectContaining({ actorName: "wang", target: "Codex · 文献" }),
    ]);
  });
});
