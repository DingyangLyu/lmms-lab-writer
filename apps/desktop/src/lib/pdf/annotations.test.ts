import { describe, expect, it } from "vitest";
import { annotationPrompt, normalizeRect } from "./annotations";

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
  it("requests exact IDs and requires verification before resolving", () => {
    const prompt = annotationPrompt(["note-1"], "codex");
    expect(prompt).toContain('["note-1"]');
    expect(prompt).toContain("sourceChanged");
    expect(prompt).toContain("writer_resolve_annotation");
    expect(prompt).toContain("writer_apply_annotation_edit");
    expect(prompt).toContain("writer_read_document");
  });
});
