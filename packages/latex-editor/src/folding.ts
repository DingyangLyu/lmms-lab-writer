import { foldService } from "@codemirror/language";
import type { Text } from "@codemirror/state";
import { getLaTeXFoldingRanges } from "./fold-ranges";

export type LatexFold = { from: number; to: number; startLine: number; comment: boolean };
const cache = new WeakMap<Text, LatexFold[]>();

function previewLength(text: string, prefix: number): number {
  return prefix + Array.from(text.slice(prefix)).slice(0, 28).join("").length;
}

/** Fold positions, including a single physical comment line. Text stays intact. */
export function latexFoldRanges(doc: Text): LatexFold[] {
  const cached = cache.get(doc);
  if (cached) return cached;
  const ranges = getLaTeXFoldingRanges(doc.toString()).map((range) => {
    const first = doc.line(range.start);
    const prefix = first.text.match(/^\s*%\s?/)?.[0].length ?? 0;
    return {
      from:
        range.kind === "comment"
          ? Math.min(first.to, first.from + previewLength(first.text, prefix))
          : first.to,
      to: doc.line(range.end).to,
      startLine: range.start,
      comment: range.kind === "comment",
    };
  });
  const commentLines = new Set<number>();
  for (const range of ranges) {
    if (!range.comment) continue;
    for (let line = range.startLine; line <= doc.lineAt(range.to).number; line++)
      commentLines.add(line);
  }
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
    const line = doc.line(lineNumber);
    if (commentLines.has(lineNumber) || line.length < 100) continue;
    const prefix = line.text.match(/^\s*%\s?/)?.[0];
    if (prefix)
      ranges.push({
        from: line.from + previewLength(line.text, prefix.length),
        to: line.to,
        startLine: lineNumber,
        comment: true,
      });
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  cache.set(doc, ranges);
  return ranges;
}

export const latexFolding = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart).number;
  return latexFoldRanges(state.doc).find((range) => range.startLine === line) ?? null;
});
