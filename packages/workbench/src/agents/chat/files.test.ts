import { beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchI18n as i18n } from "../../i18n";
import { conversationTitle } from "../context";
import { setAgentPlatform } from "../platform";
import { splitEditorSelectionMessage, withEditorSelection } from "../selection-context";
import {
  attachmentMessage,
  type DocumentAttachment,
  importBrowserDocument,
  MAX_FILE_BYTES,
  prepareChatFiles,
  splitAttachmentMessage,
} from "./files";

const validateDocuments = vi.fn();
setAgentPlatform({ openExternal: () => {}, validateDocuments, importDocumentData: vi.fn() });
const file: DocumentAttachment = {
  kind: "document",
  filename: '资料 "1".pdf',
  path: `.writer/attachments/${"a".repeat(64)}/资料 "1".pdf`,
  url: "file:///paper/fixture.pdf",
  mime: "application/pdf",
  size: 512,
  sha256: "a".repeat(64),
};
beforeEach(() => {
  validateDocuments.mockReset();
  validateDocuments.mockResolvedValue(undefined);
});
describe("file attachment payload", () => {
  it("sends a file-only instruction and validated local reference, without an image payload", async () => {
    const result = await prepareChatFiles("/paper", "", [file]);
    expect(result.images).toEqual([]);
    expect(result.text).toContain(JSON.stringify(file.path));
    expect(result.text).not.toContain("file:///");
    expect(validateDocuments).toHaveBeenCalledWith("/paper", [file]);
    expect(splitAttachmentMessage(result.text)?.files[0]?.name).toBe(file.filename);
  });
  it("keeps mixed images as native vision inputs and exposes documents to every harness", async () => {
    const image = { filename: "plot.png", mime: "image/png", url: "data:image/png;base64,fixture" };
    const result = await prepareChatFiles("/paper", "核对图表", [image, file]);
    expect(result.images).toEqual([image]);
    expect(splitAttachmentMessage(result.text)?.text).toBe("核对图表");
  });
  it("blocks missing/modified attachments before session creation or delivery", async () => {
    validateDocuments.mockRejectedValue("附件已改变");
    await expect(prepareChatFiles("/paper", "", [file])).rejects.toBe("附件已改变");
    await expect(prepareChatFiles(undefined, "", [file])).rejects.toThrow("项目");
  });
  it("preserves attachment manifests with editor context and queue roundtrips", () => {
    const roundtrip = JSON.parse(JSON.stringify({ raw: "请修订", files: [file], selection: null }));
    const text = withEditorSelection(attachmentMessage(roundtrip.raw, roundtrip.files), {
      project: "/paper",
      path: "main.tex",
      ranges: [],
    });
    const message = splitEditorSelectionMessage(text);
    expect(splitAttachmentMessage(message?.instruction || "")?.files[0]?.path).toBe(file.path);
  });
  it("does not truncate filenames, interpret malformed metadata, or read oversized browser files", async () => {
    expect(splitAttachmentMessage("ordinary text")).toBeNull();
    expect(
      splitAttachmentMessage(
        attachmentMessage("x", [file]).replace(
          JSON.stringify(file.path),
          JSON.stringify("../secret"),
        ),
      ),
    ).toBeNull();
    await expect(
      importBrowserDocument("/paper", { size: MAX_FILE_BYTES + 1 } as File),
    ).rejects.toThrow("25 MB");
  });
  it("reads back messages written in either interface language", () => {
    const selection = {
      project: "/paper",
      path: "main.tex",
      ranges: [
        {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 5,
          startOffset: 0,
          endOffset: 4,
          text: "text",
        },
      ],
    };
    const chinese = withEditorSelection(attachmentMessage("", [file]), selection);
    i18n.setLocale("en");
    try {
      const english = withEditorSelection(attachmentMessage("", [file]), selection);
      expect(english).toContain("Please read these attachments.");
      expect(english).toContain("Selection 1: L1; from 1:1 to 1:5");
      for (const text of [chinese, english]) {
        const message = splitEditorSelectionMessage(text);
        expect(message?.path).toBe("main.tex");
        expect(splitAttachmentMessage(message?.instruction ?? "")?.files[0]?.path).toBe(file.path);
        expect(conversationTitle(text)).toBe(`Attachment: ${file.filename}`);
      }
    } finally {
      i18n.setLocale("zh");
    }
  });
});
