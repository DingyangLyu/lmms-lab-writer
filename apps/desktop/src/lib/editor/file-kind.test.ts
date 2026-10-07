import { describe, expect, it } from "vitest";
import { fileKind, fileLanguage } from "./file-kind";

describe("fileKind", () => {
  it("sorts files by how the editor can show them", () => {
    expect(fileKind("figures/Plot.PNG")).toBe("image");
    expect(fileKind("build/main.pdf")).toBe("pdf");
    expect(fileKind("build/main.synctex.gz")).toBe("binary");
    expect(fileKind("slides.pptx")).toBe("binary");
    expect(fileKind("paper/main.tex")).toBe("text");
    expect(fileKind("Makefile")).toBe("text");
  });
  it("does not read a directory's dot as the extension", () => {
    expect(fileKind("v1.png/notes")).toBe("text");
    expect(fileLanguage("chapters.tex/README")).toBe("plaintext");
  });
});

describe("fileLanguage", () => {
  it("maps extensions and extensionless build files", () => {
    expect(fileLanguage("main.tex")).toBe("latex");
    expect(fileLanguage("refs.BIB")).toBe("bibtex");
    expect(fileLanguage("docker/Dockerfile")).toBe("dockerfile");
    expect(fileLanguage("notes.unknown")).toBe("plaintext");
  });
});
