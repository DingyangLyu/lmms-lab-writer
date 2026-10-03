import { describe, expect, it } from "vitest";
import { buildFileIndex, resolveFileReference } from "./file-resolution";

const files = (...paths: string[]) => buildFileIndex(paths.map((path) => ({ path, type: "file" })));
describe("exact file references and shorthand", () => {
  it("opens the root PDF without warning even with same-named build caches and bilingual outputs", () => {
    const index = files(
      "main.pdf",
      ".writer/build-cache/main/main.pdf",
      "drafts/old/main.pdf",
      "zh/main.pdf",
      "en/main.pdf",
    );
    expect(resolveFileReference("main.pdf", index, ["en/main.pdf"])).toBe("main.pdf");
    expect(resolveFileReference("zh/main.pdf", index)).toBe("zh/main.pdf");
  });
  it("keeps exact cached paths accessible without making them shorthand candidates", () => {
    const index = files(".writer/build-cache/old/main.pdf", "drafts/main.pdf", "en/main.pdf");
    expect(resolveFileReference("main.pdf", index)).toBe("en/main.pdf");
    expect(resolveFileReference(".writer/build-cache/old/main.pdf", index)).toBe(
      ".writer/build-cache/old/main.pdf",
    );
  });
  it("uses the active target only for shorthand and reports real ambiguity", () => {
    const index = files("en/main.pdf", "zh/main.pdf");
    expect(resolveFileReference("main.pdf", index, ["zh/main.pdf"])).toBe("zh/main.pdf");
    expect(() => resolveFileReference("main.pdf", index)).toThrow("指定项目相对路径");
  });
  it("does not redirect a newly compiled explicit path when the watcher has not refreshed", () => {
    expect(resolveFileReference("output/en/main.pdf", files("zh/main.pdf"))).toBe(
      "output/en/main.pdf",
    );
    expect(resolveFileReference("main.pdf", files(".writer/build-cache/test/main.pdf"))).toBe(
      "main.pdf",
    );
  });
});
