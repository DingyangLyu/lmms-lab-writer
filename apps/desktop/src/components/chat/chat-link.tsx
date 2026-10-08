"use client";
import { open } from "@tauri-apps/plugin-shell";
import { type ReactNode, useContext, useState } from "react";
import { parseChatLink } from "@/lib/chat/links";
import { ChatImageDirectory } from "./chat-image";
import { useI18n } from "@/lib/i18n";
export function ChatLink({
  href,
  children,
  onFileClick,
  onOpenExternal,
}: {
  href?: string;
  children: ReactNode;
  onFileClick?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
}) {
  const { t } = useI18n();
  const directory = useContext(ChatImageDirectory);
  const target = parseChatLink(href || "", directory);
  const [error, setError] = useState<string | null>(null);
  const activate = () => {
    if (target.kind === "file") {
      onFileClick?.(href || "");
    } else if (target.kind === "external-file") {
      onFileClick?.(href || "");
    } else if (target.kind === "external") {
      if (onOpenExternal) onOpenExternal(target.url);
      else void open(target.url).catch((cause) => setError(String(cause)));
    }
  };
  if (target.kind === "blocked")
    return <span title={t("chat.invalidFilePathOrUnsupportedLink")}>{children}</span>;
  return (
    <>
      <a
        href={href}
        data-writer-link="true"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          activate();
        }}
        onAuxClick={(event) => {
          event.preventDefault();
          if (event.button === 1) activate();
        }}
        title={
          target.kind === "file"
            ? t("chat.openPathPreviewableFilesOpenInTheEditorO", { path: target.path })
            : target.kind === "external-file"
              ? t("chat.showPathInTheFileManager", { path: target.path })
              : undefined
        }
        className="cursor-pointer underline decoration-current underline-offset-2"
      >
        {children}
      </a>
      {error && (
        <span role="alert" className="ml-1 text-xs text-red-600">
          {error}
        </span>
      )}
    </>
  );
}
