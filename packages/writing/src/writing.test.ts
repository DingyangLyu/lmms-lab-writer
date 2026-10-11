import { describe, expect, it } from "vitest";
// Also split by the desktop's reviews (reviews.rs), which must give the same hunks.
import REVIEWS from "../fixtures/review-cases.json" with { type: "json" };
import {
  citations,
  importBibliography,
  normalizeDoi,
  parseBib,
  renameBibKey,
  renameCitationKey,
} from "./bibliography";
import { reviewedText, reviewHunks } from "./review";

describe("bibliography", () => {
  it("preserves string macros, ignores commented entries and handles parenthesized entries", () => {
    const incoming =
      '% @book{ignored,title={Not imported}}\n@string{j = "My Journal"}\n@article(key,title={A (study)},journal=j)';
    const parsed = parseBib(incoming);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    const imported = importBibliography("", incoming);
    expect(imported.content).toContain('@string{j = "My Journal"}');
    expect(imported.content).not.toContain("ignored");
    expect(() => importBibliography('@string{j="Other Journal"}', incoming)).toThrow("宏");
  });
  it("preserves nested braces, protected capitals, quotes, macros and Unicode", () => {
    const source =
      '@string{j = "Journal"}\n@article{key, title={A {Large} 模型, with {nested {words}}}, author="Lyu, Dingyang and Doe, Jane", journal=j # " title", doi={10.1234/EXAMPLE}}';
    const doc = parseBib(source);
    expect(doc.errors).toEqual([]);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]?.fields.title).toBe("A {Large} 模型, with {nested {words}}");
    expect(doc.entries[0]?.fields.author).toBe("Lyu, Dingyang and Doe, Jane");
    expect(doc.entries[0]?.raw).toBe(source.slice(source.indexOf("@article")));
  });
  it("deduplicates DOI and isolates key collisions", () => {
    const old = "@article{k, title={First}, doi={10.1234/abc}}";
    const next =
      "@article{other, title={First changed}, doi={https://doi.org/10.1234/ABC}}\n@book{k,title={Different}}";
    const result = importBibliography(old, next);
    expect(result.added).toBe(1);
    expect(result.skipped).toEqual(["other"]);
    expect(result.renamed).toEqual({ k: "k_2" });
    expect(parseBib(result.content).entries).toHaveLength(2);
  });
  it("rejects malformed imports without discarding original text", () => {
    expect(() => importBibliography("@book{a,title={A}}", "@article{x,title={bad}")).toThrow(
      "未闭合",
    );
    expect(() => normalizeDoi("https://attacker.test/10.1234/a")).toThrow();
  });
  it("renames citations and crossrefs without replacing prose, labels or comments", () => {
    const source =
      "plain old \\label{old} % \\cite{old}\n\\citep[see][p. 4]{ old,new } and \\textcite{old}";
    expect(citations(source).map((c) => c.key)).toEqual(["old", "new", "old"]);
    expect(renameCitationKey(source, "old", "updated")).toContain(
      "plain old \\label{old} % \\cite{old}",
    );
    expect(renameCitationKey(source, "old", "updated")).toContain("{ updated,new }");
    expect(
      renameBibKey("@book{old,title={old}}\n@article{child,crossref={old}}", "old", "new"),
    ).toBe("@book{new,title={old}}\n@article{child,crossref={new}}");
  });
});
describe("hunk decisions", () => {
  it("rejects one hunk while retaining independent accepted changes", () => {
    const before = "a\nb\nc\nd\n",
      after = "A\nb\nc\nD\n",
      hunks = reviewHunks(before, after);
    expect(hunks).toHaveLength(2);
    if (hunks[0]) hunks[0].status = "rejected";
    expect(reviewedText(after, hunks)).toBe("a\nb\nc\nD\n");
  });
  it("handles added and deleted files and Unicode", () => {
    for (const [before, after] of [
      ["", "新段落\n"],
      ["旧文稿\n", ""],
      ["alpha\n", "alpha\n尾部"],
    ]) {
      const hunks = reviewHunks(before ?? "", after ?? "");
      for (const h of hunks) h.status = "rejected";
      expect(reviewedText(after ?? "", hunks)).toBe(before);
    }
  });
});

describe("review hunks shared with the desktop", () => {
  it.each(REVIEWS.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const hunks = reviewHunks(c.before, c.after);
    expect(hunks.map(({ before, after }) => ({ before, after }))).toEqual(c.changes);
    for (const h of hunks) expect(c.after.slice(h.from, h.to)).toBe(h.after);
    expect(
      reviewedText(
        c.after,
        hunks.map((h) => ({ ...h, status: "rejected" })),
      ),
    ).toBe(c.before);
  });
});
