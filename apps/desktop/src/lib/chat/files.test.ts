import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitEditorSelectionMessage, withEditorSelection } from "@/lib/editor/selection-context";
import {
  attachmentMessage,
  type DocumentAttachment,
  importBrowserDocument,
  MAX_FILE_BYTES,
  prepareChatFiles,
  splitAttachmentMessage,
} from "./files";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
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
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue([file]);
});
describe("file attachment payload", () => {
  it("sends a file-only instruction and validated local reference, without an image payload", async () => {
    const result = await prepareChatFiles("/paper", "", [file]);
    expect(result.images).toEqual([]);
    expect(result.text).toContain(JSON.stringify(file.path));
    expect(result.text).not.toContain("file:///");
    expect(invoke).toHaveBeenCalledWith("validate_chat_files", {
      project: "/paper",
      files: [file],
    });
    expect(splitAttachmentMessage(result.text)?.files[0]?.name).toBe(file.filename);
  });
  it("keeps mixed images as native vision inputs and exposes documents to every harness", async () => {
    const image = { filename: "plot.png", mime: "image/png", url: "data:image/png;base64,fixture" };
    const result = await prepareChatFiles("/paper", "核对图表", [image, file]);
    expect(result.images).toEqual([image]);
    expect(splitAttachmentMessage(result.text)?.text).toBe("核对图表");
  });
  it("blocks missing/modified attachments before session creation or delivery", async () => {
    vi.mocked(invoke).mockRejectedValue("附件已改变");
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
});
