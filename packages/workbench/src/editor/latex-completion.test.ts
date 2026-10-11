import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { parseBib } from "@lmms-lab/writing";
import { describe, expect, it } from "vitest";
import { latexCompletion, projectHints } from "./latex-completion";

const hints = projectHints(
  [
    { path: "refs.bib", content: "@article{einstein1905,title={On {Electrodynamics}}}" },
    { path: "intro.tex", content: "\\begin{figure}\\label{fig:setup}\\end{figure}" },
  ],
  parseBib,
);
const complete = (doc: string, explicit = false) => {
  const state = EditorState.create({ doc });
  return latexCompletion(() => hints)(new CompletionContext(state, doc.length, explicit));
};
const labels = (doc: string) => complete(doc)?.options.map((o) => o.label) ?? [];

describe("LaTeX completion", () => {
  it("offers citation keys after the last comma of a cite command", () => {
    expect(complete("see \\cite{ein")).toMatchObject({ from: 10 });
    expect(labels("see \\cite{ein")).toEqual(["einstein1905"]);
    expect(complete("\\citep[p. 2]{a, ei")?.from).toBe(16);
    expect(complete("\\citep[p. 2]{a, ei")?.options[0]?.detail).toBe("On Electrodynamics");
  });
  it("offers labels from other files and the open document", () => {
    expect(labels("\\label{eq:1} see \\eqref{")).toEqual(
      expect.arrayContaining(["fig:setup", "eq:1"]),
    );
  });
  it("offers environments and commands", () => {
    expect(labels("\\begin{equ")).toContain("equation");
    expect(labels("text \\sec")).toContain("\\section");
    expect(complete("plain words")).toBeNull();
    expect(complete("\\")).toBeNull();
    expect(complete("\\", true)).not.toBeNull();
  });
});
