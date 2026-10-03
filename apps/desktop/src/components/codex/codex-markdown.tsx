"use client";

import { memo, useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatImage } from "@/components/chat/chat-image";
import { ChatLink } from "@/components/chat/chat-link";
import { chatUrlTransform } from "@/lib/chat/links";

type Props = {
  text: string;
  onFileClick?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
};

const remarkPlugins = [remarkGfm];

export const CodexMarkdown = memo(function CodexMarkdown({
  text,
  onOpenExternal,
  onFileClick,
}: Props) {
  const components = useMemo<Components>(
    () => ({
      img: ({ src, alt }) =>
        typeof src === "string" ? <ChatImage url={src} name={alt || "图片"} /> : null,
      table: ({ children }) => (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus lets readers scroll a wide table inside the narrow sidebar.
        <section aria-label="回答表格，可横向滚动" className="codex-markdown-table" tabIndex={0}>
          <table>{children}</table>
        </section>
      ),
      a: ({ href, children }) => (
        <ChatLink href={href} onFileClick={onFileClick} onOpenExternal={onOpenExternal}>
          {children}
        </ChatLink>
      ),
    }),
    [onOpenExternal, onFileClick],
  );

  return (
    <div className="codex-markdown min-w-0 text-[13px] leading-[1.75] text-foreground select-text">
      <ReactMarkdown
        urlTransform={chatUrlTransform}
        remarkPlugins={remarkPlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
