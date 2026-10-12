import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { texErrorHint } from "./build-issues";
import { headingAt, insertList, setHeading, wrapSelection } from "./format-commands";
import { closing, scanVisual } from "./visual";

const DOC = String.raw`\documentclass{article}
\title{A Paper}
\begin{document}
\maketitle
\section{Intro}
Text with \textbf{bold \cite{knuth}} and $x^2$ % not $this$
\begin{equation}
  E = mc^2 \label{eq:e}
\end{equation}
\begin{itemize}
  \item One~more
\end{itemize}
\end{document}
`;
const kinds = (state: EditorState) =>
  scanVisual(state, {}, false).map(
    (c) => `${c.kind}:${state.sliceDoc(c.from, c.to).split("\n")[0]}`,
  );

describe("visual mode", () => {
  it("finds the constructs and leaves comments alone", () => {
    const found = kinds(EditorState.create({ doc: DOC }));
    expect(found).toEqual(
      expect.arrayContaining([
        "block:\\documentclass{article}",
        "block:\\maketitle",
        "inline:\\section{Intro}",
        "inline:\\textbf{bold \\cite{knuth}}",
        "inline:\\cite{knuth}",
        "inline:$x^2$",
        "block:\\begin{equation}",
        "block:\\begin{itemize}",
        "inline:\\item",
        "inline:~",
        "block:\\end{document}",
      ]),
    );
    expect(found.some((k) => k.includes("$this$"))).toBe(false);
    // The label inside the equation belongs to the math, not to the text.
    expect(found.some((k) => k === "inline:\\label{eq:e}")).toBe(false);
  });

  it("matches braces past escapes and comments", () => {
    const text = String.raw`{a \} {b} % }` + "\n}";
    expect(closing(text, 0)).toBe(text.length);
    expect(closing("{unclosed", 0)).toBe(-1);
  });

  it("explains common TeX errors", () => {
    expect(texErrorHint("Undefined control sequence.")).toBeTruthy();
    expect(texErrorHint("LaTeX Error: File `foo.sty' not found.")).toMatch(/\.sty|package/i);
    expect(texErrorHint("Something new")).toBeNull();
  });
});

/** Enough of an EditorView for text commands. */
function fakeView(doc: string, from: number, to = from) {
  const view = {
    state: EditorState.create({ doc, selection: EditorSelection.single(from, to) }),
    dispatch(spec: TransactionSpec) {
      view.state = view.state.update(spec).state;
    },
    focus() {},
  };
  return view as unknown as EditorView & { state: EditorState };
}

describe("formatting commands", () => {
  it("wraps and unwraps a selection", () => {
    const view = fakeView("make this bold", 5, 9);
    wrapSelection(view, "\\textbf{", "}");
    expect(view.state.doc.toString()).toBe("make \\textbf{this} bold");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "this",
    );
    wrapSelection(view, "\\textbf{", "}");
    expect(view.state.doc.toString()).toBe("make this bold");
  });

  it("sets and clears headings", () => {
    const view = fakeView("Results\nmore", 2);
    setHeading(view, "section");
    expect(view.state.doc.toString()).toBe("\\section{Results}\nmore");
    expect(headingAt(view.state)).toBe("section");
    setHeading(view, "subsection");
    expect(view.state.doc.line(1).text).toBe("\\subsection{Results}");
    setHeading(view, null);
    expect(view.state.doc.line(1).text).toBe("Results");
  });

  it("turns lines into a list", () => {
    const doc = "a\nb";
    const view = fakeView(doc, 0, doc.length);
    insertList(view, "enumerate");
    expect(view.state.doc.toString()).toBe(
      "\\begin{enumerate}\n  \\item a\n  \\item b\n\\end{enumerate}",
    );
  });
});
