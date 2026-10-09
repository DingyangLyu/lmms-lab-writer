import { workbenchI18n as i18n } from "../../i18n";
import { stripWriterContext } from "../context";
export type CodexItem = {
  id: string;
  type: string;
  text?: string;
  phase?: string;
  content?: Array<{ type: string; text?: string; url?: string; path?: string }> | string[];
  path?: string;
  summary?: string[];
  command?: string;
  cwd?: string;
  query?: string;
  action?: {
    type?: string;
    query?: string | null;
    queries?: string[] | null;
    url?: string | null;
    pattern?: string | null;
  } | null;
  results?: Array<{
    type?: string;
    title?: string;
    url?: string;
    snippet?: string;
    domain?: string;
    ref_id?: string;
  }> | null;
  status?: string;
  /** Item lifecycle from app-server notifications, including items without a status field. */
  lifecycleStatus?: "inProgress" | "completed";
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: Array<{
    path: string;
    kind?: string | { type: string; move_path?: string | null };
    diff?: string;
  }>;
  server?: string;
  tool?: string;
  error?: string;
};
export const MAX_IN_MEMORY_HISTORY_ITEMS = 5000;
export function trimCodexHistory(items: CodexItem[]): CodexItem[] {
  return items.length > MAX_IN_MEMORY_HISTORY_ITEMS
    ? items.slice(-MAX_IN_MEMORY_HISTORY_ITEMS)
    : items;
}

export type CodexEvent = {
  id?: number | string;
  method?: string;
  params?: {
    threadId?: string;
    turnId?: string;
    itemId?: string;
    item?: CodexItem;
    delta?: string;
    changes?: CodexItem["changes"];
    summaryIndex?: number;
    contentIndex?: number;
    turn?: { id: string; status?: string; error?: { message: string } | null };
    error?: { message?: string };
    willRetry?: boolean;
    message?: string;
    reason?: string;
    command?: string;
    cwd?: string;
    requestId?: number | string;
    permissions?: Record<string, unknown>;
    /** A shared backend's additions (backend.ts): the agent's applied changes, who is busy. */
    results?: Array<{ path: string; status: string; reason?: string }>;
    busy?: { thread: string; userName: string; mine: boolean } | null;
    questions?: Array<{
      id: string;
      header: string;
      question: string;
      options?: Array<{ label: string; description?: string }>;
    }>;
  };
};

export function textForCodexItem(item: CodexItem): string {
  if (item.type === "userMessage") {
    return stripWriterContext(
      item.content
        ?.filter((part) => typeof part !== "string" && part.type === "text")
        .map((part) => (typeof part === "string" ? "" : (part.text ?? "")))
        .join("\n") ?? "",
    );
  }
  if (item.type === "reasoning") {
    return (
      item.text ||
      item.summary?.filter(Boolean).join("\n\n") ||
      item.content?.filter((part): part is string => typeof part === "string").join("\n\n") ||
      ""
    );
  }
  return item.text ?? "";
}

export function visibleCodexItem(item: CodexItem): boolean {
  return [
    "userMessage",
    "agentMessage",
    "reasoning",
    "commandExecution",
    "fileChange",
    "webSearch",
    "mcpToolCall",
    "imageView",
  ].includes(item.type);
}

export function upsertCodexItem(items: CodexItem[], item: CodexItem): CodexItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function normalizeCodexItem(
  item: CodexItem,
  lifecycleStatus: "inProgress" | "completed",
  previous?: CodexItem,
): CodexItem {
  const normalized: CodexItem = { ...item, lifecycleStatus };

  if (item.type === "reasoning") {
    // The authoritative item exposes summaries as an array, not `text`.
    // An interrupted turn can finish with empty arrays after emitting a
    // summary delta, so retain that visible delta when no summary is saved.
    const summary = item.summary?.filter(Boolean).join("\n\n");
    const content = item.content
      ?.filter((part): part is string => typeof part === "string")
      .join("\n\n");
    normalized.text = summary || item.text || previous?.text || content;
  } else if (lifecycleStatus === "inProgress" && previous?.text && !item.text) {
    // A started notification can arrive after a text delta.
    normalized.text = previous.text;
  }

  if (item.type === "commandExecution") {
    normalized.aggregatedOutput = item.aggregatedOutput ?? previous?.aggregatedOutput;
  }

  return normalized;
}

export function reduceCodexEvent(items: CodexItem[], event: CodexEvent): CodexItem[] {
  const params = event.params;
  if (!params) return items;
  if (event.method === "item/started" || event.method === "item/completed") {
    if (!params.item || !visibleCodexItem(params.item)) return items;
    const lifecycleStatus = event.method === "item/started" ? "inProgress" : "completed";
    const previous = items.find((item) => item.id === params.item?.id);
    const item = normalizeCodexItem(params.item, lifecycleStatus, previous);
    if (params.item.type === "userMessage") {
      const localIndex = items.findLastIndex((item) => item.id.startsWith("local-"));
      if (localIndex >= 0) {
        const next = [...items];
        next[localIndex] = item;
        return next;
      }
    }
    return trimCodexHistory(upsertCodexItem(items, item));
  }
  if (event.method === "item/agentMessage/delta" && params.itemId && params.delta) {
    const existing = items.find((item) => item.id === params.itemId);
    return trimCodexHistory(
      upsertCodexItem(items, {
        ...existing,
        id: params.itemId,
        type: "agentMessage",
        text: `${existing?.text ?? ""}${params.delta}`,
        lifecycleStatus: "inProgress",
      }),
    );
  }
  if (event.method === "item/reasoning/summaryTextDelta" && params.itemId && params.delta) {
    const existing = items.find((item) => item.id === params.itemId);
    return trimCodexHistory(
      upsertCodexItem(items, {
        ...existing,
        id: params.itemId,
        type: "reasoning",
        text: `${existing?.text ?? ""}${params.delta}`,
        lifecycleStatus: "inProgress",
      }),
    );
  }
  if (event.method === "item/commandExecution/outputDelta" && params.itemId && params.delta) {
    const existing = items.find((item) => item.id === params.itemId);
    return trimCodexHistory(
      upsertCodexItem(items, {
        ...existing,
        id: params.itemId,
        type: "commandExecution",
        aggregatedOutput: `${existing?.aggregatedOutput ?? ""}${params.delta}`,
        lifecycleStatus: "inProgress",
      }),
    );
  }
  if (event.method === "item/fileChange/patchUpdated" && params.itemId && params.changes) {
    const existing = items.find((item) => item.id === params.itemId);
    return trimCodexHistory(
      upsertCodexItem(items, {
        ...existing,
        id: params.itemId,
        type: "fileChange",
        changes: params.changes,
        lifecycleStatus: "inProgress",
      }),
    );
  }
  return items;
}

export function itemsFromCodexThread(thread: {
  turns?: Array<{ status?: string; items?: CodexItem[] }>;
}): CodexItem[] {
  return trimCodexHistory(
    (thread.turns ?? []).flatMap((turn) =>
      (turn.items ?? []).filter(visibleCodexItem).map((item, index, visibleItems) => {
        const active =
          turn.status === "inProgress" &&
          (item.status === "inProgress" ||
            (index === visibleItems.length - 1 &&
              ["webSearch", "reasoning", "mcpToolCall"].includes(item.type)));
        return normalizeCodexItem(item, active ? "inProgress" : "completed");
      }),
    ),
  );
}

export function imagesForCodexItem(item: CodexItem): Array<{ url: string; name: string }> {
  if (item.type === "imageView" && item.path)
    return [{ url: item.path, name: item.path.split("/").pop() || i18n.t("msg.viewImage") }];
  return (item.content ?? []).flatMap((part) => {
    if (typeof part === "string" || !["image", "localImage"].includes(part.type)) return [];
    const url = part.url || part.path;
    return url ? [{ url, name: part.path?.split("/").pop() || i18n.t("msg.imageAttachment") }] : [];
  });
}
