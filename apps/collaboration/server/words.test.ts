import { describe, expect, it } from "vitest";
import { fixture } from "./test-fixture";

describe("personal dictionaries", () => {
  it("keeps each member's words with their account", async () => {
    const f = await fixture();
    const other = await f.invite("editor", "coauthor");
    const words = async (cookie: string) =>
      (await f.call("/me/words", undefined, cookie)).data as string[];
    expect(await words(f.owner)).toEqual([]);
    expect((await f.call("/me/words", { word: "perovskite" }, f.owner)).status).toBe(200);
    expect((await f.call("/me/words", { words: ["Zotero", "perovskite"] }, f.owner)).status).toBe(
      200,
    );
    expect(await words(f.owner)).toEqual(["perovskite", "Zotero"]);
    expect(await words(other)).toEqual([]);
    expect((await f.call("/me/words", { word: "two words" }, f.owner)).status).toBe(400);
    await f.call("/me/words/remove", { word: "Zotero" }, f.owner);
    expect(await words(f.owner)).toEqual(["perovskite"]);
    expect((await f.call("/me/words")).status).toBe(401);
  });
});
