import { describe, expect, it } from "vitest";
import { documentEdits, mergeText } from "./merge";

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
    for (const e of changes.toReversed())
      text = text.slice(0, e.from) + e.insert + text.slice(e.to);
    expect(text).toBe("new\nunchanged\nend");
  });
  it("retains both concurrent insertions as conflicts at the same position", () => {
    const result = mergeText("甲乙", "甲新乙", "甲旧乙");
    expect(result.content).toBeNull();
    expect(result.parts.find((p) => p.text === null)).toMatchObject({ ours: "新", theirs: "旧" });
  });
});
