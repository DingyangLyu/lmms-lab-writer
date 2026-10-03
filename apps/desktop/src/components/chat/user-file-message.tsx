"use client";
import { splitAttachmentMessage } from "@/lib/chat/files";
import { ChatLink } from "./chat-link";
export function UserFileMessage({
  text,
  onFileClick,
}: {
  text: string;
  onFileClick?: (path: string) => void;
}) {
  const attachment = splitAttachmentMessage(text);
  if (!attachment) return <>{text}</>;
  return (
    <>
      {attachment.text}
      <span className="mt-2 flex flex-wrap gap-2">
        {attachment.files.map((file) => (
          <span
            key={file.path}
            className="inline-flex min-w-0 max-w-full flex-col border border-border px-2 py-1 text-xs"
            title={file.name}
          >
            <ChatLink
              href={file.path.split("/").map(encodeURIComponent).join("/")}
              onFileClick={onFileClick}
            >
              {file.name}
            </ChatLink>
            <span className="text-muted">
              {Math.max(1, Math.ceil(file.size / 1024))} KB · 文件附件
            </span>
          </span>
        ))}
      </span>
    </>
  );
}
