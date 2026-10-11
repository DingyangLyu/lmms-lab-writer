import { describe, expect, it } from "vitest";
import { typedBy, walk } from "./scene";

describe("demo scene cursors", () => {
  it("knows when each line is typed", () => {
    expect(typedBy(["ab", "cde"], 0)).toBe(2);
    expect(typedBy(["ab", "cde"], 1)).toBe(6);
  });

  it("waits, then steps one character at a time to each stop", () => {
    const stops = [
      [4, 2],
      [7, 1],
      [5, 0],
    ] as const;
    const path = Array.from({ length: 22 }, (_, t) => walk(stops, t, 2));
    expect(path).toEqual([4, 4, 4, 4, 5, 5, 6, 6, 7, 7, 7, 6, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
    // Never between characters, never more than one character a step.
    for (const [t, column] of path.entries()) {
      expect(Number.isInteger(column)).toBe(true);
      if (t) expect(Math.abs(column - (path[t - 1] ?? column))).toBeLessThanOrEqual(1);
    }
  });
});
