import { describe, expect, it } from "vitest";
import { destinationFraction, fitPageWidth, pageScale, viewportAnchor } from "./viewport";

describe("responsive PDF viewport", () => {
  it("follows both growing and shrinking panels rather than keeping the opening width", () => {
    expect([480, 1400, 700].map((width) => fitPageWidth(width, 16, 16))).toEqual([448, 1368, 668]);
    expect(pageScale(fitPageWidth(1400, 16, 16), 595.28)).toBeGreaterThan(2);
  });
  it("uses actual portrait/landscape PDF widths and excludes container padding", () => {
    expect(pageScale(842, 842)).toBe(1);
    expect(pageScale(595, 595)).toBe(1);
    expect(fitPageWidth(20, 16, 16)).toBe(1);
  });
  it("preserves the visible position as a fraction of the same page", () => {
    expect(viewportAnchor(600, 100, 1000)).toBe(0.5);
    expect(viewportAnchor(30, 100, 1000)).toBe(0);
  });
});

describe("PDF link destinations", () => {
  const page = { num: 4, gen: 0 };
  it("places contents, citation and cross-reference targets on their page", () => {
    expect(destinationFraction([page, { name: "XYZ" }, 72, 692, null], 792)).toBeCloseTo(0.126, 3);
    expect(destinationFraction([page, { name: "FitH" }, 396], 792)).toBe(0.5);
    expect(destinationFraction([page, { name: "FitR" }, 0, 0, 100, 792], 792)).toBe(0);
  });
  it("goes to the top of the page when the destination has no position", () => {
    expect(destinationFraction([page, { name: "Fit" }], 792)).toBe(0);
    expect(destinationFraction([page, { name: "XYZ" }, null, null, null], 792)).toBe(0);
    expect(destinationFraction("chapter.1", 792)).toBe(0);
    expect(destinationFraction([page, { name: "XYZ" }, 0, 900, 0], 792)).toBe(0);
  });
});
