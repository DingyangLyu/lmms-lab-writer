import { splitAttachmentMessage } from "@/lib/chat/files";
import { splitEditorSelectionMessage } from "@/lib/editor/selection-context";

const CONTEXT_PREFIX = "[Writer conversation ID: ";
/** Hide Writer's transport context in message bubbles, retaining delegated tasks/results. */
export function stripWriterContext(text: string): string {
  return text.replace(/^\[Writer conversation ID: [^\n]+\]\n[^\n]*\n\n/, "");
}

/** Native previews (e.g. Codex `thread.preview`) are the raw first message, context included. */
export function conversationTitle(text: string | null | undefined, limit = 60): string {
  if (!text) return "";
  let body = stripWriterContext(text);
  if (body.startsWith(CONTEXT_PREFIX)) {
    const end = body.indexOf("\n\n");
    body = end >= 0 ? body.slice(end + 2) : "";
  }
  body = splitEditorSelectionMessage(body)?.instruction ?? body;
  const attachment = splitAttachmentMessage(body);
  const line = (attachment?.text ?? body)
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  const title =
    (line !== "请阅读这些附件。" && line) ||
    (attachment?.files[0] ? `附件：${attachment.files[0].name}` : line || "");
  const chars = Array.from(title);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : title;
}
