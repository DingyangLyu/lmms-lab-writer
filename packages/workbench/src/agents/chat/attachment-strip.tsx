"use client";
import { FileIcon } from "@phosphor-icons/react";
import { useWorkbenchI18n as useI18n } from "../../i18n";
import { ChatImage } from "./chat-image";
import { isDocument } from "./files";
import type { ChatImageFile } from "./images";
export function AttachmentStrip({
  files,
  onRemove,
  disabled,
}: {
  files: ChatImageFile[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  if (!files.length) return null;
  return (
    <div className="flex gap-2 overflow-x-auto p-2">
      {files.map((file, index) => (
        <div key={file.url} className="flex shrink-0 flex-col gap-1">
          {isDocument(file) ? (
            <div
              className="flex max-w-56 items-center gap-2 border border-border bg-background p-2"
              title={file.filename}
            >
              <FileIcon className="size-6 shrink-0" />
              <div className="min-w-0 text-xs">
                <span className="block truncate">{file.filename}</span>
                <span className="text-muted">
                  {t("chat.sizeKbFileAttachment", {
                    size: Math.max(1, Math.ceil(file.size / 1024)),
                  })}
                </span>
              </div>
            </div>
          ) : (
            <ChatImage url={file.url} name={file.filename} />
          )}
          <button
            type="button"
            aria-label={t("chat.removeAttachmentName", { name: file.filename })}
            disabled={disabled}
            onClick={() => onRemove(index)}
            className="text-xs text-muted hover:text-accent disabled:opacity-40"
          >
            {t("chat.removeAttachment")}
          </button>
        </div>
      ))}
    </div>
  );
}
