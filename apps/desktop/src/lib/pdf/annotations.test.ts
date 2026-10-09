import { describe, expect, it } from "vitest";
import { annotationPrompt } from "./annotations";

describe("PDF annotation tasks", () => {
  it("requests exact IDs and requires verification before resolving", () => {
    const prompt = annotationPrompt(["note-1"], "codex");
    expect(prompt).toContain('["note-1"]');
    expect(prompt).toContain("sourceChanged");
    expect(prompt).toContain("writer_resolve_annotation");
    expect(prompt).toContain("writer_apply_annotation_edit");
    expect(prompt).toContain("writer_read_document");
  });
});
