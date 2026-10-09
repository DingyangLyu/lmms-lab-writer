import { type CodexItem, trimCodexHistory } from "@lmms-lab/workbench/agents";
import { i18n } from "@/lib/i18n";

type Block = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Block[];
  is_error?: boolean;
  source?: { type: string; media_type?: string; data?: string; url?: string };
};
export type ClaudeEvent = {
  type: string;
  uuid?: string;
  error?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  errors?: string[];
  request_id?: string;
  request?: { subtype: string; tool_name?: string; input: Record<string, unknown> };
  message?: { id?: string; content: Block[] | string };
  event?: {
    type: string;
    index?: number;
    message?: { id: string };
    content_block?: Block;
    delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
  };
};
export type ClaudeMessages = { items: CodexItem[]; messageId: string };
const image = (block: Block) =>
  block.source?.type === "base64"
    ? `data:${block.source.media_type};base64,${block.source.data}`
    : block.source?.url;
const outputText = (content: string | Block[] | undefined): string =>
  typeof content === "string"
    ? content
    : content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text || "")
        .join("\n") || "";
function blockItem(block: Block, id: string): CodexItem {
  if (block.type === "text") return { id, type: "agentMessage", text: block.text || "" };
  if (block.type === "thinking")
    return { id, type: "reasoning", text: block.thinking || "", lifecycleStatus: "inProgress" };
  return {
    id: block.id || id,
    type:
      block.name === "Bash"
        ? "commandExecution"
        : block.name === "WebSearch" || block.name === "WebFetch"
          ? "webSearch"
          : "mcpToolCall",
    query: block.name === "WebSearch" ? String(block.input?.query || "") : undefined,
    server: "Claude Code",
    tool: block.name || i18n.t("msg.tool"),
    command: block.name === "Bash" ? String(block.input?.command || "") : undefined,
    text: JSON.stringify(block.input || {}, null, 2),
    status: "inProgress",
    lifecycleStatus: "inProgress",
  };
}
export function reduceClaudeEvent(state: ClaudeMessages, event: ClaudeEvent): ClaudeMessages {
  let items = [...state.items];
  let messageId = state.messageId;
  const put = (item: CodexItem) => {
    const index = items.findIndex((old) => old.id === item.id);
    if (index < 0) items.push(item);
    else items[index] = { ...items[index], ...item };
  };
  if (event.type === "stream_event" && event.event) {
    const stream = event.event;
    if (stream.type === "message_start") messageId = stream.message?.id || event.uuid || "stream";
    const id = `${messageId}:${stream.index ?? 0}`;
    if (stream.type === "content_block_start" && stream.content_block)
      put(blockItem(stream.content_block, id));
    if (stream.type === "content_block_delta") {
      const delta = stream.delta;
      const index = items.findIndex((item) => item.id === id);
      if (index >= 0)
        items = items.map((item, i) =>
          i === index
            ? { ...item, text: (item.text || "") + (delta?.text || delta?.thinking || "") }
            : item,
        );
    }
    if (stream.type === "content_block_stop")
      items = items.map((item) =>
        item.id === id ? { ...item, lifecycleStatus: "completed" } : item,
      );
  } else if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    event.message.content.forEach((block, index) => {
      const prefix = `${event.message?.id || event.uuid}:`;
      const finalPhase = `claude-final:${event.uuid}:${index}`;
      const expected =
        block.type === "text"
          ? "agentMessage"
          : block.type === "thinking"
            ? "reasoning"
            : "mcpToolCall";
      const existing =
        items.find((item) => item.phase === finalPhase) ??
        [...items]
          .reverse()
          .find(
            (item) =>
              item.id.startsWith(prefix) &&
              item.type === expected &&
              !item.phase?.startsWith("claude-final:"),
          );
      const item = blockItem(block, existing?.id || `${prefix}${event.uuid}:${index}`);
      item.phase = finalPhase;
      if (block.type !== "tool_use") item.lifecycleStatus = "completed";
      put(item);
    });
  } else if (event.type === "user" && event.message) {
    const blocks =
      typeof event.message.content === "string"
        ? [{ type: "text", text: event.message.content }]
        : event.message.content;
    const userContent: Array<{ type: string; text?: string; url?: string }> = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        items = items.map((item) =>
          item.id === block.tool_use_id
            ? {
                ...item,
                status: block.is_error ? "failed" : "completed",
                lifecycleStatus: "completed",
                aggregatedOutput: outputText(block.content),
              }
            : item,
        );
        if (Array.isArray(block.content))
          for (const entry of block.content) {
            const url = image(entry);
            if (url)
              put({
                id: `${block.tool_use_id}:image`,
                type: "imageView",
                content: [{ type: "image", url }],
              });
          }
      } else if (block.type === "text") userContent.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        const url = image(block);
        if (url) userContent.push({ type: "image", url });
      }
    }
    if (userContent.length)
      put({ id: event.uuid || `user:${items.length}`, type: "userMessage", content: userContent });
  } else if (event.type === "writer_steering") {
    items = items.map((item) =>
      item.status === "inProgress"
        ? { ...item, status: "declined", lifecycleStatus: "completed" }
        : item,
    );
  } else if (event.type === "writer_error") {
    items = items.map((item) =>
      item.status === "inProgress"
        ? { ...item, status: "failed", lifecycleStatus: "completed" }
        : item,
    );
  } else if (event.type === "result" || event.type === "writer_done") {
    items = items.map((item) => ({
      ...item,
      lifecycleStatus: "completed",
      status: item.status === "inProgress" ? "completed" : item.status,
    }));
  }
  return { items: trimCodexHistory(items), messageId };
}
