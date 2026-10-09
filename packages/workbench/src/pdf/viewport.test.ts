import { describe, expect, it } from "vitest";
import { fitPageWidth, pageScale, viewportAnchor } from "./viewport";

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
