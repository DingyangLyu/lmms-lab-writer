import { describe, expect, it } from "vitest";
import { locateQuote } from "./locate-quote";

const SOURCE = [
  "\\section{Results}",
  "The \\emph{activation} barrier of the electrolyte",
  "decreases with temperature~\\cite{knuth1984}.",
  "",
  "Another paragraph.",
].join("\n");

describe("PDF quotes in the source", () => {
  it("finds the words across line breaks, TeX commands and hyphenation", () => {
    const { from, to, exact } = locateQuote(
      SOURCE,
      "activation barrier of the elec-trolyte decreases",
      2,
      3,
    );
    expect(exact).toBe(true);
    expect(SOURCE.slice(from, to)).toBe("activation} barrier of the electrolyte\ndecreases");
  });
  it("anchors on both ends when the middle differs, e.g. a citation number", () => {
    const { from, to, exact } = locateQuote(SOURCE, "decreases with temperature [1].", 3, 3);
    expect(exact).toBe(true);
    expect(SOURCE.slice(from, to)).toBe("decreases with temperature");
  });
  it("falls back to the lines SyncTeX named, without their indentation", () => {
    const { from, to, exact } = locateQuote("a\n   Totally different words here\nb", "∑ x²", 2, 2);
    expect(exact).toBe(false);
    expect("a\n   Totally different words here\nb".slice(from, to)).toBe(
      "Totally different words here",
    );
  });
});
