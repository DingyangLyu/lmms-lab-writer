import { describe, expect, it } from "vitest";
import type { Comment } from "../shared/api";
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
});
