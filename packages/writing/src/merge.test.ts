import { describe, expect, it } from "vitest";
// Also run by the desktop's Rust merge (document_merge.rs), which must give the same results.
import CASES from "../fixtures/merge-cases.json" with { type: "json" };
import { documentEdits, hunks, mergeText } from "./merge";

describe("incremental merges", () => {
  it("keeps identifier changes atomic but merges separate Chinese edits in one line", () => {
    expect(mergeText("cat", "bat", "car").content).toBeNull();
    expect(mergeText("甲段与乙段", "甲新段与乙段", "甲段与乙新段").content).toBe("甲新段与乙新段");
  });
  it("applies disjoint changes without replacing the unchanged middle", () => {
    const base = "first\nunchanged\nlast";
    const changes = documentEdits(base, "new\nunchanged\nend");
    expect(changes).toHaveLength(2);
    let text = base;
    for (const e of [...changes].reverse())
      text = text.slice(0, e.from) + e.insert + text.slice(e.to);
    expect(text).toBe("new\nunchanged\nend");
  });
  it("retains both concurrent insertions as conflicts at the same position", () => {
    const result = mergeText("甲乙", "甲新乙", "甲旧乙");
    expect(result.content).toBeNull();
    expect(result.parts.find((p) => p.text === null)).toMatchObject({ ours: "新", theirs: "旧" });
  });
});

describe("merges shared with the desktop", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const { content, parts } = mergeText(c.base, c.ours, c.theirs);
    expect({ content, parts }).toEqual({ content: c.content, parts: c.parts });
  });

  it("finds a shortest edit script, and settles for one change when that is too costly", () => {
    expect(hunks([..."abcabba"], [..."cbabac"])).toEqual([
      [0, 2, 0, 0],
      [3, 3, 1, 2],
      [5, 6, 4, 4],
      [7, 7, 5, 6],
    ]);
    expect(hunks([..."same"], [..."same"])).toEqual([]);
    const a = Array.from({ length: 6000 }, (_, i) => `a${i}`),
      b = Array.from({ length: 6000 }, (_, i) => `b${i}`);
    expect(hunks(["x", ...a, "y"], ["x", ...b, "y"])).toEqual([[1, 6001, 1, 6001]]);
  });
});
