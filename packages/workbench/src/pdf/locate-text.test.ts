import { describe, expect, it } from "vitest";
import { joinPages, locateInPdf, type PageText } from "./locate-text";

const run = (text: string, x: number, top: number, width = text.length * 5) => ({
  text,
  x,
  width,
  top,
  bottom: top + 10,
});
const pages: PageText[] = [
  {
    page: 1,
    width: 600,
    height: 800,
    runs: [
      run("2 Results", 72, 90),
      run("We measure the activation", 72, 110),
      run("barrier Ea of the electrolyte [1].", 72, 124),
      run("We measure the activation again.", 72, 160),
    ],
  },
];

describe("source text found in a compiled PDF", () => {
  const text = joinPages(pages);
  it("finds a comment's words across lines, LaTeX commands and citations", () => {
    const marks = locateInPdf(
      text,
      "the \\emph{activation} barrier $E_a$ of the electrolyte~\\cite{wang2024}.",
    );
    expect(marks?.map((m) => [m.page, Math.round(m.y * 800)])).toEqual([
      [1, 110],
      [1, 124],
    ]);
    // It starts at "the", not at the start of the line.
    expect(Math.round((marks?.[0]?.x ?? 0) * 600)).toBe(72 + 11 * 5);
  });
  it("tells repeats apart by which one is meant", () => {
    const second = locateInPdf(text, "We measure the activation", 1);
    expect(second?.map((m) => Math.round(m.y * 800))).toEqual([160]);
  });
  it("gives nothing for words the PDF does not have yet", () => {
    expect(locateInPdf(text, "Written after the last build.")).toBeNull();
  });
});
