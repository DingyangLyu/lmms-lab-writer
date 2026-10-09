import { describe, expect, it } from "vitest";
import { chatUrlTransform, fileLinkReference, parseChatLink } from "./links";

describe("chat document links stay in the editor", () => {
  it("opens the exact PDF link from a chat rather than navigating the webview", () => {
    expect(parseChatLink("main.pdf", "/paper")).toMatchObject({ kind: "file", path: "main.pdf" });
    expect(parseChatLink("tauri://localhost/main.pdf", "/paper")).toMatchObject({
      kind: "file",
      path: "main.pdf",
    });
    expect(parseChatLink("tauri://localhost/paper/en/main.pdf#page=2", "/paper")).toMatchObject({
      kind: "file",
      path: "en/main.pdf",
      page: 2,
    });
    expect(parseChatLink("http://tauri.localhost/en/main.pdf", "/paper")).toMatchObject({
      kind: "file",
      path: "en/main.pdf",
    });
  });
  it("supports absolute files, encoded names and line/page anchors", () => {
    expect(parseChatLink("file:///paper/%E4%B8%AD%E6%96%87.tex#L12C3", "/paper")).toMatchObject({
      path: "中文.tex",
      line: 12,
      column: 3,
    });
    expect(parseChatLink("/paper/en/main.tex:25:2", "/paper")).toMatchObject({
      path: "en/main.tex",
      line: 25,
      column: 2,
    });
    expect(parseChatLink("./build/paper.pdf#page=7", "/paper")).toMatchObject({
      path: "build/paper.pdf",
      page: 7,
    });
    expect(fileLinkReference({ kind: "file", path: "中文.tex", line: 12 })).toBe("中文.tex:12");
  });
  it("separates external links and rejects unsafe paths", () => {
    expect(parseChatLink("https://example.org/paper.pdf", "/paper").kind).toBe("external");
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,x",
      "../../private.txt",
      "//evil.test/file",
    ]) {
      expect(parseChatLink(value, "/paper").kind).toBe("blocked");
    }
    expect(chatUrlTransform("file:///paper/main.pdf", "href")).toBe("file:///paper/main.pdf");
    expect(parseChatLink("file:///tmp/matos-architecture-editable.pptx", "/paper")).toMatchObject({
      kind: "external-file",
      path: "/tmp/matos-architecture-editable.pptx",
    });
  });
});

it("decodes literal percent signs once and supports Windows drive case", () => {
  expect(parseChatLink("file:///paper/100%25-proof.tex", "/paper")).toMatchObject({
    kind: "file",
    path: "100%-proof.tex",
  });
  expect(parseChatLink("file:///c:/Paper/main.tex#L4", "C:\\Paper")).toMatchObject({
    kind: "file",
    path: "main.tex",
    line: 4,
  });
});

it("routes outside files to the file manager without granting project editor access", () => {
  expect(parseChatLink("/paper-other/file.tex", "/paper")).toMatchObject({
    kind: "external-file",
    path: "/paper-other/file.tex",
  });
  expect(parseChatLink("file:///tmp/100%25%20editable.pptx", "/paper")).toMatchObject({
    kind: "external-file",
    path: "/tmp/100% editable.pptx",
  });
  expect(parseChatLink("slides/deck.pptx", "/paper")).toMatchObject({
    kind: "file",
    path: "slides/deck.pptx",
  });
  expect(parseChatLink("file://remote/share/deck.pptx", "/paper").kind).toBe("blocked");
});

it("keeps encoded # and ? in attachment names instead of treating them as anchors", () => {
  const sha = "a".repeat(64);
  for (const name of ["paper#2.pdf", "Q&A?.docx", "中文 资料.pdf"]) {
    const href = `.writer/attachments/${sha}/${name}`.split("/").map(encodeURIComponent).join("/");
    expect(parseChatLink(href, "/paper")).toMatchObject({
      kind: "file",
      path: `.writer/attachments/${sha}/${name}`,
    });
  }
  expect(parseChatLink("main.tex#L12", "/paper")).toMatchObject({ path: "main.tex", line: 12 });
});
