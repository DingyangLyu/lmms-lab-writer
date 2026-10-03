import { describe, expect, it } from "vitest";
import { getLaTeXFoldingRanges } from "./latex-folding";

describe("LaTeX folding ranges", () => {
  it("nests chapters, sections, and subsections until the next peer or parent", () => {
    const source = [
      "\\begin{document}",
      "\\section{First}",
      "First text",
      "\\subsection{Detail}",
      "Detail text",
      "\\subsubsection{Further}",
      "Further text",
      "\\subsection{Next detail}",
      "More text",
      "\\section{Second}",
      "Second text",
      "\\end{document}",
    ].join("\n");

    expect(getLaTeXFoldingRanges(source)).toEqual([
      { start: 1, end: 12 },
      { start: 2, end: 9 },
      { start: 4, end: 7 },
      { start: 6, end: 7 },
      { start: 8, end: 9 },
      { start: 10, end: 11 },
    ]);
  });

  it.each([
    "figure",
    "table",
    "longtable",
    "align",
    "equation",
    "tabular",
  ])("folds the %s environment from begin through end", (name) => {
    const source = `\\begin{${name}}\ncontent\n\\end{${name}}`;
    expect(getLaTeXFoldingRanges(source)).toEqual([{ start: 1, end: 3 }]);
  });

  it("keeps nested figure and tabular ranges, but ignores a same-line pair", () => {
    const source = [
      "\\begin{figure}",
      "\\includegraphics{plot.png}",
      "\\begin{tabular}{lc}",
      "A & B \\\\",
      "\\end{tabular}",
      "\\end{figure}",
      "\\begin{equation} x=1 \\end{equation}",
    ].join("\n");

    expect(getLaTeXFoldingRanges(source)).toEqual([
      { start: 1, end: 6 },
      { start: 3, end: 5 },
    ]);
  });

  it("folds only consecutive full-line comments and respects escaped percent", () => {
    const source = [
      "  % First note",
      "% Second note \\section{Not real}",
      "text \\% literal percent \\begin{table}",
      "inside",
      "\\end{table} % inline note",
      "% Another note",
      "% Last note",
    ].join("\n");

    expect(getLaTeXFoldingRanges(source)).toEqual([
      { start: 1, end: 2, kind: "comment" },
      { start: 3, end: 5 },
      { start: 6, end: 7, kind: "comment" },
    ]);
  });

  it("ignores fake commands and percent signs inside verbatim blocks", () => {
    const source = [
      "\\begin{verbatim}",
      "\\section{Fake}",
      "% This is verbatim text",
      "\\begin{figure}",
      "\\end{verbatim}",
      "\\section{Real}",
      "\\verb|\\subsection{Fake}| text",
      "\\subsection{Real detail}",
      "Detail text",
    ].join("\n");

    expect(getLaTeXFoldingRanges(source)).toEqual([
      { start: 1, end: 5 },
      { start: 6, end: 9 },
      { start: 8, end: 9 },
    ]);
  });

  it("ignores incomplete environments and headings with no body", () => {
    const source = ["\\section{One}", "\\section{Two}", "\\begin{figure}", "still typing"].join(
      "\n",
    );

    expect(getLaTeXFoldingRanges(source)).toEqual([{ start: 2, end: 4 }]);
  });

  it("handles CRLF and excludes trailing empty lines from a section range", () => {
    const source = "\\section{Title}\r\nBody\r\n\r\n";
    expect(getLaTeXFoldingRanges(source)).toEqual([{ start: 1, end: 2 }]);
  });

  it("does not create duplicate or crossing ranges for commands sharing a line", () => {
    const source = [
      "\\section{Title} \\begin{figure}",
      "image",
      "\\end{figure}",
      "more text",
      "\\section{Next}",
      "body",
    ].join("\n");

    expect(getLaTeXFoldingRanges(source)).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ]);
  });
});
