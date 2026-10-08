"use client";

import { memo, useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatImage } from "@/components/chat/chat-image";
import { ChatLink } from "@/components/chat/chat-link";
import { chatUrlTransform } from "@/lib/chat/links";
import { useI18n } from "@/lib/i18n";

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
  const { t } = useI18n();
  const components = useMemo<Components>(
    () => ({
      img: ({ src, alt }) =>
        typeof src === "string" ? <ChatImage url={src} name={alt || t("chat.image")} /> : null,
      table: ({ children }) => (
        <section
          aria-label={t("chat.tableInTheAnswerScrollSideways")}
          className="codex-markdown-table"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus lets readers scroll a wide table inside the narrow sidebar.
          tabIndex={0}
        >
          <table>{children}</table>
        </section>
      ),
      a: ({ href, children }) => (
        <ChatLink href={href} onFileClick={onFileClick} onOpenExternal={onOpenExternal}>
          {children}
        </ChatLink>
      ),
    }),
    [onOpenExternal, onFileClick, t],
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
