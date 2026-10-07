import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { latexLanguage } from "./language";

function tokens(text: string) {
  const state = EditorState.create({ doc: text, extensions: [latexLanguage] });
  const tree = ensureSyntaxTree(state, state.doc.length, 1000);
  if (!tree) throw new Error("Expected LaTeX syntax tree");
  const spans: Array<{ from: number; to: number; kind: string }> = [];
  highlightTree(
    tree,
    tagHighlighter([
      { tag: tags.comment, class: "comment" },
      { tag: tags.keyword, class: "command" },
      { tag: tags.labelName, class: "reference" },
      { tag: tags.string, class: "math" },
    ]),
    (from, to, kind) => spans.push({ from, to, kind }),
  );
  return (offset: number) => spans.find((span) => span.from <= offset && span.to > offset)?.kind;
}

describe("LaTeX source highlighting", () => {
  it("keeps a long Chinese comment green while its text changes incrementally", () => {
    const text = `% ${"写作思路和参考文献。".repeat(30)}`;
    for (const suffix of ["j", "jian", "建模"]) {
      const value = text + suffix;
      expect(tokens(value)(value.length - 1)).toBe("comment");
    }
  });
  it("distinguishes citation keys from commands and surrounding prose", () => {
    const text = "正文 \\parencite[见][p.2]{vasp2026,other} 后文";
    const at = tokens(text);
    expect(at(text.indexOf("parencite"))).toBe("command");
    expect(at(text.indexOf("vasp2026"))).toBe("reference");
    expect(at(text.indexOf("后文"))).toBeUndefined();
  });
  it("does not treat an escaped percent as the start of a comment", () => {
    const text = "100\\% 正文 % 真正的注释";
    const at = tokens(text);
    expect(at(text.indexOf("正文"))).toBeUndefined();
    expect(at(text.indexOf("真正"))).toBe("comment");
  });
  it("returns to prose after package arguments and inline math", () => {
    const text = "\\usepackage[UTF8]{ctex}\n正文 $U$ 后文";
    const at = tokens(text);
    expect(at(text.indexOf("正文"))).toBeUndefined();
    expect(at(text.indexOf("$U") + 1)).toBe("math");
    expect(at(text.indexOf("后文"))).toBeUndefined();
  });
});
