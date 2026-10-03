import { describe, expect, it } from "vitest";
import { type CodexItem, itemsFromCodexThread, reduceCodexEvent, textForCodexItem } from "./events";

describe("Codex app-server event stream", () => {
  it("streams text and replaces it with the authoritative completed item", () => {
    let items: CodexItem[] = [];
    items = reduceCodexEvent(items, {
      method: "item/started",
      params: { item: { id: "msg1", type: "agentMessage", text: "" } },
    });
    items = reduceCodexEvent(items, {
      method: "item/agentMessage/delta",
      params: { itemId: "msg1", delta: "Finding " },
    });
    items = reduceCodexEvent(items, {
      method: "item/agentMessage/delta",
      params: { itemId: "msg1", delta: "papers" },
    });
    expect(items[0]?.text).toBe("Finding papers");
    items = reduceCodexEvent(items, {
      method: "item/completed",
      params: { item: { id: "msg1", type: "agentMessage", text: "Found papers." } },
    });
    expect(items).toEqual([
      {
        id: "msg1",
        type: "agentMessage",
        text: "Found papers.",
        lifecycleStatus: "completed",
      },
    ]);
  });

  it("tracks web search lifecycle even though the server item has no status", () => {
    const started = reduceCodexEvent([], {
      method: "item/started",
      params: { item: { id: "web1", type: "webSearch", query: "RAG original paper" } },
    });
    expect(started[0]?.lifecycleStatus).toBe("inProgress");
    const completed = reduceCodexEvent(started, {
      method: "item/completed",
      params: {
        item: {
          id: "web1",
          type: "webSearch",
          query: "RAG original paper",
          results: [{ title: "Original paper", url: "https://example.org/paper" }],
        },
      },
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]?.lifecycleStatus).toBe("completed");
    expect(completed[0]?.results?.[0]?.title).toBe("Original paper");
  });

  it("replaces the optimistic user message with the persisted app-server item", () => {
    const items: CodexItem[] = [
      { id: "local-123", type: "userMessage", content: [{ type: "text", text: "查找文献" }] },
    ];
    const updated = reduceCodexEvent(items, {
      method: "item/completed",
      params: {
        item: {
          id: "user-456",
          type: "userMessage",
          content: [{ type: "text", text: "查找文献\n\n引用上下文" }],
        },
      },
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe("user-456");
  });

  it("streams command output and keeps completion metadata", () => {
    const started = reduceCodexEvent([], {
      method: "item/started",
      params: {
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "tectonic --synctex main.tex",
          status: "inProgress",
        },
      },
    });
    const streamed = reduceCodexEvent(started, {
      method: "item/commandExecution/outputDelta",
      params: { itemId: "cmd-1", delta: "Compiling…\n" },
    });
    expect(streamed[0]?.aggregatedOutput).toBe("Compiling…\n");
    const completed = reduceCodexEvent(streamed, {
      method: "item/completed",
      params: {
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "tectonic --synctex main.tex",
          status: "failed",
          exitCode: 1,
          durationMs: 1250,
          aggregatedOutput: "Compiling…\nError: missing font\n",
        },
      },
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      lifecycleStatus: "completed",
      status: "failed",
      exitCode: 1,
      durationMs: 1250,
      aggregatedOutput: "Compiling…\nError: missing font\n",
    });
  });

  it("keeps the visible reasoning summary after completion", () => {
    const started = reduceCodexEvent([], {
      method: "item/started",
      params: { item: { id: "think-1", type: "reasoning", summary: [], content: [] } },
    });
    expect(started[0]?.lifecycleStatus).toBe("inProgress");
    const streamed = reduceCodexEvent(started, {
      method: "item/reasoning/summaryTextDelta",
      params: { itemId: "think-1", summaryIndex: 0, delta: "Checking the source" },
    });
    const completed = reduceCodexEvent(streamed, {
      method: "item/completed",
      params: { item: { id: "think-1", type: "reasoning", summary: [], content: [] } },
    });
    expect(completed[0]?.lifecycleStatus).toBe("completed");
    const completedItem = completed[0];
    if (!completedItem) throw new Error("Expected completed reasoning item");
    expect(textForCodexItem(completedItem)).toBe("Checking the source");

    const authoritative = reduceCodexEvent(completed, {
      method: "item/completed",
      params: {
        item: { id: "think-1", type: "reasoning", summary: ["Verified the source"], content: [] },
      },
    });
    const authoritativeItem = authoritative[0];
    if (!authoritativeItem) throw new Error("Expected authoritative reasoning item");
    expect(textForCodexItem(authoritativeItem)).toBe("Verified the source");
  });

  it("updates file changes before completion and marks loaded history complete", () => {
    const changes = [{ path: "/project/main.bib", kind: { type: "update" }, diff: "+@article{}" }];
    const started = reduceCodexEvent([], {
      method: "item/started",
      params: { item: { id: "patch-1", type: "fileChange", status: "inProgress", changes: [] } },
    });
    const updated = reduceCodexEvent(started, {
      method: "item/fileChange/patchUpdated",
      params: { itemId: "patch-1", changes },
    });
    expect(updated[0]?.changes).toEqual(changes);
    expect(updated[0]?.lifecycleStatus).toBe("inProgress");

    const history = itemsFromCodexThread({
      turns: [
        {
          items: [
            { id: "patch-1", type: "fileChange", status: "completed", changes },
            { id: "think-2", type: "reasoning", summary: ["Checked citations"], content: [] },
          ],
        },
      ],
    });
    expect(history[0]?.lifecycleStatus).toBe("completed");
    const historyReasoning = history[1];
    if (!historyReasoning) throw new Error("Expected reasoning in history");
    expect(textForCodexItem(historyReasoning)).toBe("Checked citations");
  });

  it("restores a running tool when an active thread is reopened", () => {
    const items = itemsFromCodexThread({
      turns: [
        {
          status: "inProgress",
          items: [
            { id: "cmd-done", type: "commandExecution", command: "pwd", status: "completed" },
            { id: "search-active", type: "webSearch", query: "recent papers" },
          ],
        },
      ],
    });
    expect(items.map((item) => item.lifecycleStatus)).toEqual(["completed", "inProgress"]);
  });
});

describe("Codex image history", () => {
  it("retains inline and local images when live user messages replace optimistic items", () => {
    const image = { type: "image", url: "data:image/png;base64,fixture" };
    const items = reduceCodexEvent([{ id: "local-1", type: "userMessage", content: [image] }], {
      method: "item/completed",
      params: { item: { id: "server-1", type: "userMessage", content: [image] } },
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.content).toEqual([image]);
    const history = itemsFromCodexThread({
      turns: [
        {
          status: "completed",
          items: [...items, { id: "view", type: "imageView", path: "/tmp/figure.png" }],
        },
      ],
    });
    expect(history.map((item) => item.type)).toEqual(["userMessage", "imageView"]);
  });
});
