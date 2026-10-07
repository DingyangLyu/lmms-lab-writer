import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { latexFolding, latexFoldRanges } from "./folding";

function stateFor(doc: string) {
  return EditorState.create({ doc, extensions: [latexFolding, codeFolding()] });
}

describe("LaTeX view-only folding", () => {
  it("folds and unfolds a single long Chinese comment without changing any source text", () => {
    const text = `% ${"这是需要暂时收起的写作思路。".repeat(30)}`;
    let state = stateFor(text);
    const fold = latexFoldRanges(state.doc)[0];
    if (!fold) throw new Error("Expected a single-line comment fold");
    expect(fold.from).toBeGreaterThan(2);
    expect(fold.to).toBe(text.length);
    state = state.update({ effects: foldEffect.of(fold) }).state;
    expect(foldedRanges(state).size).toBe(1);
    expect(state.doc.toString()).toBe(text);
    state = state.update({ effects: unfoldEffect.of(fold) }).state;
    expect(foldedRanges(state).size).toBe(0);
    expect(state.doc.toString()).toBe(text);
  });

  it("keeps section, figure, table, and multi-line comment folds distinct", () => {
    const state = stateFor(
      [
        "\\section{章节}",
        "正文",
        "% 旧稿",
        "% 第二行",
        "\\begin{figure}",
        "\\includegraphics{a.png}",
        "\\end{figure}",
        "\\begin{table}",
        "\\begin{tabular}{cc}",
        "A & B",
        "\\end{tabular}",
        "\\end{table}",
        "\\section{下一节}",
        "下一节正文",
      ].join("\n"),
    );
    const folds = latexFoldRanges(state.doc);
    expect(folds.map((fold) => fold.startLine)).toEqual([1, 3, 5, 8, 9, 13]);
    expect(folds.filter((fold) => fold.comment)).toHaveLength(1);
  });

  it("keeps a collapsed comment intact while editing surrounding text", () => {
    const text = `正文\n% ${"注释".repeat(80)}\n下一段`;
    let state = stateFor(text);
    const fold = latexFoldRanges(state.doc).find((range) => range.comment);
    if (!fold) throw new Error("Expected comment fold");
    state = state.update({ effects: foldEffect.of(fold) }).state;
    state = state.update({ changes: { from: 0, insert: "新增" } }).state;
    expect(foldedRanges(state).size).toBe(1);
    expect(state.doc.toString()).toBe(`新增${text}`);
  });
});
