import { describe, expect, it } from "vitest";
import { findMatches, replaceAll, searchPattern } from "./project-search";

const text = "\\section{Method}\nThe method works.\nMethods vary; method-wise fine.\n";
const pattern = (query: string, options: Partial<Parameters<typeof searchPattern>[0]> = {}) => {
  const found = searchPattern({
    query,
    caseSensitive: false,
    regexp: false,
    wholeWord: false,
    ...options,
  });
  if (!(found instanceof RegExp)) throw new Error("no pattern");
  return found;
};

describe("project search", () => {
  it("finds matches with lines and previews, honouring the switches", () => {
    const all = findMatches(text, pattern("method"));
    expect(all.map((m) => m.line)).toEqual([1, 2, 3, 3]);
    expect(all[1]).toMatchObject({ preview: "The method works.", at: 4, length: 6 });
    expect(findMatches(text, pattern("method", { caseSensitive: true }))).toHaveLength(2);
    expect(findMatches(text, pattern("method", { wholeWord: true })).map((m) => m.line)).toEqual([
      1, 2, 3,
    ]);
    expect(findMatches(text, pattern("\\\\section\\{(\\w+)\\}", { regexp: true }))).toHaveLength(1);
    expect(findMatches("a.b", pattern("."))).toHaveLength(1);
    expect(
      searchPattern({ query: "(", caseSensitive: false, regexp: true, wholeWord: false }),
    ).toBeInstanceOf(Error);
    expect(
      searchPattern({ query: "", caseSensitive: false, regexp: false, wholeWord: false }),
    ).toBeNull();
    expect(findMatches("aaaa", pattern("a*", { regexp: true }))).toHaveLength(1);
  });
  it("shortens long lines around the match", () => {
    const long = `${"x".repeat(100)} needle ${"y".repeat(100)}`;
    const [match] = findMatches(long, pattern("needle"));
    expect(match?.preview.startsWith("…")).toBe(true);
    expect(match?.preview.slice(match.at, match.at + match.length)).toBe("needle");
  });
  it("replaces literally, or with groups in regular expressions", () => {
    expect(replaceAll(text, pattern("method", { wholeWord: true }), "$1 approach", false)).toEqual({
      content:
        "\\section{$1 approach}\nThe $1 approach works.\nMethods vary; $1 approach-wise fine.\n",
      count: 3,
    });
    expect(
      replaceAll(
        "\\cite{a} and \\cite{b}",
        pattern("\\\\cite\\{(\\w+)\\}", { regexp: true }),
        "\\citep{$1}",
        true,
      ),
    ).toEqual({ content: "\\citep{a} and \\citep{b}", count: 2 });
    expect(replaceAll("x", pattern("x*", { regexp: true }), "y", true)).toEqual({
      content: "y",
      count: 1,
    });
  });
});
