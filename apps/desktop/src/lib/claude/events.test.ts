import { expect, it } from "vitest";
import { type ClaudeEvent, reduceClaudeEvent } from "./events";

it("reconciles per-block Claude snapshots without losing thinking or duplicating streamed text", () => {
  const events: ClaudeEvent[] = [
    { type: "stream_event", event: { type: "message_start", message: { id: "msg" } } },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "核对文献" },
      },
    },
    {
      type: "assistant",
      uuid: "thinking",
      message: { id: "msg", content: [{ type: "thinking", thinking: "核对文献" }] },
    },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "已完成" },
      },
    },
    {
      type: "assistant",
      uuid: "answer",
      message: { id: "msg", content: [{ type: "text", text: "已完成" }] },
    },
  ];
  const live = events.reduce(reduceClaudeEvent, { items: [], messageId: "" });
  const restored = events
    .filter((e) => e.type === "assistant")
    .reduce(reduceClaudeEvent, { items: [], messageId: "" });
  expect(live.items.map((i) => [i.type, i.text])).toEqual([
    ["reasoning", "核对文献"],
    ["agentMessage", "已完成"],
  ]);
  expect(restored.items.map((i) => [i.type, i.text])).toEqual(
    live.items.map((i) => [i.type, i.text]),
  );
  expect(reduceClaudeEvent(live, events[6] as ClaudeEvent).items).toHaveLength(2);
});
it("keeps a tool running until its result and preserves denied operations", () => {
  let state = reduceClaudeEvent(
    { items: [], messageId: "" },
    {
      type: "assistant",
      uuid: "tool",
      message: {
        id: "m",
        content: [
          { type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "main.tex" } },
        ],
      },
    },
  );
  expect(state.items[0]?.status).toBe("inProgress");
  state = reduceClaudeEvent(state, {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          is_error: true,
          content: "Permission denied",
        },
      ],
    },
  });
  expect(state.items[0]).toMatchObject({ status: "failed", aggregatedOutput: "Permission denied" });
  expect(reduceClaudeEvent(state, { type: "writer_done" }).items[0]?.status).toBe("failed");
});
