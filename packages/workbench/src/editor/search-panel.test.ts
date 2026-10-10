import { SearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { countMatches } from "./search-panel";

const doc = "\\section{Intro}\nWe cite \\cite{a}.\nThe intro and INTRO again.";
const state = (from = 0, to = from) =>
  EditorState.create({ doc, selection: EditorSelection.single(from, to) });

describe("find in the editor", () => {
  it("counts matches with case, whole-word and regular-expression switches", () => {
    expect(countMatches(state(), new SearchQuery({ search: "intro" })).total).toBe(3);
    expect(
      countMatches(state(), new SearchQuery({ search: "intro", caseSensitive: true })).total,
    ).toBe(1);
    expect(
      countMatches(state(), new SearchQuery({ search: "\\\\(section|cite)\\{", regexp: true }))
        .total,
    ).toBe(2);
    expect(countMatches(state(), new SearchQuery({ search: "in", wholeWord: true })).total).toBe(0);
  });
  it("says which match is selected, and nothing for an empty or broken search", () => {
    const at = doc.indexOf("INTRO");
    expect(countMatches(state(at, at + 5), new SearchQuery({ search: "intro" }))).toEqual({
      total: 3,
      at: 3,
      more: false,
    });
    expect(countMatches(state(), new SearchQuery({ search: "" })).total).toBe(0);
    expect(countMatches(state(), new SearchQuery({ search: "(", regexp: true })).total).toBe(0);
  });
});
