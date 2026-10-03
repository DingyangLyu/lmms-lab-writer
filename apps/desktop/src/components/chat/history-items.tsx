"use client";
import { memo, useCallback, useMemo, useRef } from "react";
import { CodexActivityCard } from "@/components/codex/codex-activity-card";
import { CodexMarkdown } from "@/components/codex/codex-markdown";
import { type CodexItem, imagesForCodexItem, textForCodexItem } from "@/lib/codex/events";
import { splitEditorSelectionMessage } from "@/lib/editor/selection-context";
import { ChatImage } from "./chat-image";
import { UserFileMessage } from "./user-file-message";

type Props = {
  items: CodexItem[];
  directory?: string;
  onFileClick?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
};
/** Composer keystrokes never traverse or parse the saved transcript. Streaming replaces only changed rows. */
export const ChatHistoryItems = memo(function ChatHistoryItems({
  items,
  directory,
  onFileClick,
  onOpenExternal,
}: Props) {
  const handlers = useRef({ onFileClick, onOpenExternal });
  handlers.current = { onFileClick, onOpenExternal };
  const fileClick = useCallback((path: string) => handlers.current.onFileClick?.(path), []);
  const externalClick = useCallback((url: string) => handlers.current.onOpenExternal?.(url), []);
  const external = onOpenExternal ? externalClick : undefined;
  return useMemo(
    () =>
      items.map((item) => (
        <HistoryItem
          key={item.id}
          item={item}
          directory={directory}
          onFileClick={fileClick}
          onOpenExternal={external}
        />
      )),
    [items, directory, fileClick, external],
  );
});
const HistoryItem = memo(function HistoryItem({
  item,
  directory,
  onFileClick,
  onOpenExternal,
}: { item: CodexItem } & Omit<Props, "items">) {
  if (item.type === "userMessage")
    return (
      <div className="ml-5 border-l-2 border-foreground bg-accent-hover px-3 py-2 text-sm whitespace-pre-wrap break-words">
        <div className="flex flex-wrap gap-2">
          {imagesForCodexItem(item).map((image) => (
            <ChatImage key={image.url} url={image.url} name={image.name} />
          ))}
        </div>
        <UserFileMessage
          text={
            splitEditorSelectionMessage(textForCodexItem(item))?.instruction ??
            textForCodexItem(item)
          }
          onFileClick={onFileClick}
        />
      </div>
    );
  if (item.type === "imageView")
    return (
      <div className="border-l-2 border-accent p-2">
        <span className="mb-1 block text-xs text-muted">查看图片</span>
        {imagesForCodexItem(item).map((image) => (
          <ChatImage key={image.url} url={image.url} name={image.name} />
        ))}
      </div>
    );
  if (item.type === "agentMessage")
    return item.text ? (
      <CodexMarkdown text={item.text} onFileClick={onFileClick} onOpenExternal={onOpenExternal} />
    ) : null;
  return <CodexActivityCard item={item} directory={directory} onFileClick={onFileClick} />;
});
