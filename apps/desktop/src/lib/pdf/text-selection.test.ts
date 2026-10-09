import { describe, expect, it } from "vitest";
import { type Box, nearestBox, offsetAt, sideOf, wordAt } from "./text-selection";

const line = (top: number, left = 100, right = 500): Box => ({
  left,
  right,
  top,
  bottom: top + 16,
});

describe("PDF selection snapping", () => {
  // Two lines of a single column, then a two-column line pair further down.
  const boxes = [line(100), line(120), line(300, 100, 280), line(300, 320, 500)];

  it("keeps a point on text on that text", () => {
    expect(nearestBox(boxes, 200, 108)).toBe(0);
    expect(sideOf(line(100), 200, 108)).toBe("inside");
  });
  it("snaps the left page margin to the start of the line beside it", () => {
    const index = nearestBox(boxes, 40, 128);
    expect(index).toBe(1);
    expect(sideOf(line(120), 40, 128)).toBe("start");
  });
  it("snaps the right page margin to the end of the line beside it", () => {
    expect(nearestBox(boxes, 560, 108)).toBe(0);
    expect(sideOf(line(100), 560, 108)).toBe("end");
  });
  it("snaps blank space above a line to its start and below a line to its end", () => {
    expect(nearestBox(boxes, 300, 60)).toBe(0);
    expect(sideOf(line(100), 300, 60)).toBe("start");
    expect(nearestBox(boxes, 300, 180)).toBe(1);
    expect(sideOf(line(120), 300, 180)).toBe("end");
  });
  it("chooses the column under the pointer, not the other one on the same line", () => {
    expect(nearestBox(boxes, 150, 290)).toBe(2);
    expect(nearestBox(boxes, 450, 290)).toBe(3);
    expect(nearestBox(boxes, 290, 308)).toBe(2);
  });
  it("has no answer without text", () => {
    expect(nearestBox([], 10, 10)).toBe(-1);
  });
});

describe("caret offsets", () => {
  // Ten 10px-wide characters starting at x = 100.
  const measure = (index: number) => ({ left: 100 + index * 10, right: 110 + index * 10 });
  it("places the caret before the character whose centre is right of the pointer", () => {
    expect(offsetAt(10, 100, measure)).toBe(0);
    expect(offsetAt(10, 104, measure)).toBe(0);
    expect(offsetAt(10, 106, measure)).toBe(1);
    expect(offsetAt(10, 151, measure)).toBe(5);
    expect(offsetAt(10, 400, measure)).toBe(10);
  });
  it("selects whole words on double-click", () => {
    expect(wordAt("alpha beta gamma", 7)).toEqual([6, 10]);
    expect(wordAt("alpha beta gamma", 0)).toEqual([0, 5]);
    expect(wordAt("alpha beta gamma", 16)).toEqual([11, 16]);
  });
});
