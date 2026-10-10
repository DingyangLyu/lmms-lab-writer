import { describe, expect, it } from "vitest";
import { fixture } from "./test-fixture";

describe("project overview", () => {
  it("returns in one request what the separate reads return", async () => {
    const f = await fixture();
    await f.call(`/projects/${f.project}/files`, { path: "main.tex", content: "x\n" }, f.owner);
    const prefix = `/projects/${f.project}`;
    const all = (await f.call(`${prefix}/overview`, undefined, f.owner)).data;
    for (const [key, path] of [
      ["files", "/files"],
      ["comments", "/comments"],
      ["members", "/members"],
      ["snapshots", "/snapshots"],
      ["proposals", "/proposals"],
      ["summary", ""],
    ] as const)
      expect(all[key]).toEqual((await f.call(`${prefix}${path}`, undefined, f.owner)).data);
    // No build yet is null here (the separate read answers `{ ok: true }`).
    expect(all.latestBuild).toBeNull();
    expect(all.files.map((x: { path: string }) => x.path)).toEqual(["main.tex"]);
    // Only members read it.
    const other = await f.invite("viewer", "viewer1");
    expect((await f.call(`${prefix}/overview`, undefined, other)).status).toBe(200);
    expect((await f.call(`${prefix}/overview`)).status).toBe(401);
  });
});
