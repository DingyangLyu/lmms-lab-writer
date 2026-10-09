import { describe, expect, it } from "vitest";
import { annotationPrompt, joinLines, mergeMarks, normalizeRect } from "./annotations";

describe("PDF annotation geometry", () => {
  it("clips a cross-page selection to rectangles belonging to the current page", () => {
    const page = { left: 0, top: 0, right: 600, bottom: 800 };
    const rects = [
      { left: 100, top: 700, right: 500, bottom: 800 },
      { left: 100, top: 820, right: 500, bottom: 900 },
    ];
    const current = rects.filter(
      (rect) =>
        rect.right > page.left &&
        rect.left < page.right &&
        rect.bottom > page.top &&
        rect.top < page.bottom,
    );
    expect(current).toEqual([rects[0]]);
  });
  it("keeps top-left coordinates stable across zoom and scroll", () => {
    const a = normalizeRect(
      { left: 110, top: 240, right: 310, bottom: 260 },
      { left: 10, top: 40, width: 600, height: 800 },
      1,
      1,
    );
    const b = normalizeRect(
      { left: 220, top: 680, right: 620, bottom: 720 },
      { left: 20, top: 280, width: 1200, height: 1600 },
      1,
      2,
    );
    expect(a).toEqual(b);
    expect(a?.y).toBe(0.25);
    expect(a?.pageHeight).toBe(800);
  });
  it("clips rectangles to individual pages and rejects off-page fragments", () => {
    expect(
      normalizeRect(
        { left: 0, top: 0, right: 100, bottom: 50 },
        { left: 0, top: 100, width: 600, height: 800 },
        2,
        1,
      ),
    ).toBeNull();
    const rect = normalizeRect(
      { left: -20, top: 90, right: 50, bottom: 120 },
      { left: 0, top: 100, width: 600, height: 800 },
      2,
      1,
    );
    expect(rect?.x).toBe(0);
    expect(rect?.y).toBe(0);
    expect(rect?.height).toBe(0.025);
  });
  it("quotes lines as running text and rejoins words hyphenated at a line end", () => {
    expect(
      joinLines(["Paragraph six begins.  sigma ", "elec-", "trolyte state-of-the-", "art", ""]),
    ).toBe("Paragraph six begins. sigma elec-trolyte state-of-the-art");
    expect(joinLines(["cata-", "lyst"])).toBe("cata-lyst");
    expect(joinLines(["a 1-", "2 b"])).toBe("a 1- 2 b");
  });
  it("merges the rectangles of each line and keeps lines and pages apart", () => {
    const mark = (page: number, x: number, y: number, width: number) => ({
      page,
      x,
      y,
      width,
      height: 0.02,
      pageWidth: 600,
      pageHeight: 800,
    });
    const merged = mergeMarks([
      mark(1, 0.1, 0.5, 0.2),
      mark(1, 0.305, 0.5, 0.01),
      mark(1, 0.32, 0.501, 0.5),
      mark(1, 0.1, 0.53, 0.8),
      mark(2, 0.1, 0.1, 0.3),
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0]?.x).toBe(0.1);
    expect(merged[0]?.width).toBeCloseTo(0.72);
    expect(merged[1]?.y).toBe(0.53);
    expect(merged[2]?.page).toBe(2);
    // Columns separated by a wide gap stay separate marks.
    expect(mergeMarks([mark(1, 0.1, 0.5, 0.3), mark(1, 0.55, 0.5, 0.3)])).toHaveLength(2);
  });
  it("requests exact IDs and requires verification before resolving", () => {
    const prompt = annotationPrompt(["note-1"], "codex");
    expect(prompt).toContain('["note-1"]');
    expect(prompt).toContain("sourceChanged");
    expect(prompt).toContain("writer_resolve_annotation");
    expect(prompt).toContain("writer_apply_annotation_edit");
    expect(prompt).toContain("writer_read_document");
  });
});
