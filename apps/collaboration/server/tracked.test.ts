import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Member, ProjectOverview } from "../shared/api";
import { changesOf, resolveChanges, trackEdits } from "../shared/tracked";
import { tooManyChanges } from "./collaboration";
import { fixture } from "./test-fixture";

describe("track changes on the server", () => {
  it("turns tracking on for everyone or for one member, for those who edit", async () => {
    const f = await fixture();
    const viewer = await f.invite("viewer", "viewer");
    const overview = async () =>
      (await f.call(`/projects/${f.project}/overview`, undefined, f.owner)).data as ProjectOverview;
    const mine = (o: ProjectOverview) => o.members.find((m: Member) => m.username === "owner");
    expect((await overview()).summary.trackAll).toBe(false);
    expect(mine(await overview())?.tracking).toBe(false);

    expect(
      (await f.call(`/projects/${f.project}/tracking`, { everyone: true }, f.owner)).status,
    ).toBe(200);
    expect((await overview()).summary.trackAll).toBe(true);
    await f.call(`/projects/${f.project}/tracking`, { everyone: false, mine: true }, f.owner);
    const after = await overview();
    expect([after.summary.trackAll, mine(after)?.tracking]).toEqual([false, true]);

    expect(
      (await f.call(`/projects/${f.project}/tracking`, { everyone: true }, viewer)).status,
    ).toBe(403);
    expect((await f.call(`/projects/${f.project}/tracking`, {}, f.owner)).status).toBe(400);
  });

  it("syncs tracked changes beside the text, and refuses other shared types", async () => {
    const f = await fixture();
    const file = (
      await f.call(
        `/projects/${f.project}/files`,
        { path: "main.tex", content: "Hello world\n" },
        f.owner,
      )
    ).data.id as string;
    const a = await f.peer(f.owner, file);
    const text = a.doc.getText("content");
    const update = a.capture(() => {
      const before = resolveChanges(a.doc).changes;
      text.delete(6, 5);
      text.insert(6, "team");
      trackEdits(a.doc, before, [{ fromA: 6, toA: 11, fromB: 6, toB: 10, deleted: "world" }], {
        author: "owner-id",
        name: "owner",
      });
    });
    a.send("u1", update);
    expect((await a.next("ack")).id).toBe("u1");
    // Someone opening the file later gets the changes with the text.
    const b = await f.peer(f.owner, file);
    expect(b.doc.getText("content").toString()).toBe("Hello team\n");
    expect(resolveChanges(b.doc).changes.map((c) => [c.kind, c.from, c.to, c.text])).toEqual([
      ["delete", 6, 6, "world"],
      ["insert", 6, 10, undefined],
    ]);

    b.send(
      "u2",
      b.capture(() => b.doc.getMap("other").set("x", 1)),
    );
    expect((await b.next("error")).message).toMatch(/超过限制/);
    const c = await f.peer(f.owner, file);
    c.send(
      "u3",
      c.capture(() => changesOf(c.doc).set("big", { text: "x".repeat(1_100_000) } as never)),
    );
    expect((await c.next("error")).message).toMatch(/修订太多/);
  });

  it("refuses only edits that add to tracked changes beyond the limit", () => {
    const doc = (changes: number) => {
      const d = new Y.Doc();
      d.getText("content").insert(0, "text");
      for (let i = 0; i < changes; i++)
        changesOf(d).set(`c${i}`, { text: "x".repeat(100_000) } as never);
      return d;
    };
    // Over the limit already (made before it, or by a server-side edit): typing and accepting
    // still go through, so the file never locks; adding more does not.
    const over = doc(11);
    expect(tooManyChanges(over, over)).toBe(false);
    expect(tooManyChanges(over, doc(10))).toBe(false);
    expect(tooManyChanges(over, doc(12))).toBe(true);
    expect(tooManyChanges(doc(9), doc(11))).toBe(true);
    expect(tooManyChanges(doc(0), doc(9))).toBe(false);
  });

  it("tracks a member's replacements from outside the editor only while their tracking is on", async () => {
    const f = await fixture();
    const file = (
      await f.call(
        `/projects/${f.project}/files`,
        { path: "main.tex", content: "alpha beta\n" },
        f.owner,
      )
    ).data.id as string;
    const replace = (expected: string, content: string) =>
      f.call(`/projects/${f.project}/files/${file}`, { expected, content }, f.owner, "PUT");
    expect((await replace("alpha beta\n", "alpha gamma\n")).status).toBe(200);
    const before = await f.peer(f.owner, file);
    expect(changesOf(before.doc).size).toBe(0);
    before.ws.terminate();
    await f.call(`/projects/${f.project}/tracking`, { mine: true }, f.owner);
    expect((await replace("alpha gamma\n", "alpha delta\n")).status).toBe(200);
    const { doc } = await f.peer(f.owner, file);
    const text = doc.getText("content").toString();
    expect(text).toBe("alpha delta\n");
    expect(
      resolveChanges(doc).changes.map((c) => [c.kind, c.name, c.text ?? text.slice(c.from, c.to)]),
    ).toEqual([
      ["delete", "owner", "gamma"],
      ["insert", "owner", "delta"],
    ]);
  });
});
