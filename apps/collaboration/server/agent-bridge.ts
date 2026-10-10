/**
 * What one AI conversation may learn about another in the same project: its transcript as
 * text and its last answer, from each harness's own record (a Codex thread, Claude Code's
 * stream-json events, OpenCode's messages). The prompts that hand work between conversations
 * are written here too.
 */
type Json = Record<string, unknown>;
export type Entry = { role: "user" | "assistant" | "tool"; text: string };

const LIMIT = 30_000;
/** The runner's own preamble before each message ("[Writer conversation ID: …]" and context). */
const PREAMBLE = /^\[Writer conversation ID: [^\]\n]+\]\n[^\n]*\n\n/;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((b) => ((b as Json)?.type === "text" ? String((b as Json).text ?? "") : ""))
          .join("\n")
      : "";

function toolLine(name: string, input: unknown) {
  const i = (input ?? {}) as Json;
  const detail = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? "";
  return `${name}${detail ? `: ${clip(String(detail).replace(/\s+/g, " "), 200)}` : ""}`;
}

/** Codex `thread/read` with turns. */
function codexEntries(data: Json): Entry[] {
  const turns = ((data.thread as Json | undefined)?.turns ?? []) as Json[];
  const entries: Entry[] = [];
  for (const turn of turns)
    for (const item of (turn.items ?? []) as Json[]) {
      if (item.type === "userMessage") entries.push({ role: "user", text: textOf(item.content) });
      else if (item.type === "agentMessage")
        entries.push({ role: "assistant", text: String(item.text ?? "") });
      else if (item.type === "fileChange")
        entries.push({
          role: "tool",
          text: `edited ${((item.changes ?? []) as Json[]).map((c) => c.path).join(", ")}`,
        });
      else if (item.type === "commandExecution")
        entries.push({ role: "tool", text: `ran ${String(item.command ?? "")}` });
    }
  return entries;
}

/** Claude Code's saved stream-json events. */
function claudeEntries(data: Json): Entry[] {
  const entries: Entry[] = [];
  for (const event of (data.events ?? []) as Json[]) {
    const message = event.message as Json | undefined;
    if (event.type === "user" && message) {
      const text = textOf(message.content);
      if (text) entries.push({ role: "user", text });
    } else if (event.type === "assistant" && Array.isArray(message?.content))
      for (const block of message.content as Json[]) {
        if (block.type === "text" && block.text)
          entries.push({ role: "assistant", text: String(block.text) });
        if (block.type === "tool_use")
          entries.push({ role: "tool", text: toolLine(String(block.name), block.input) });
      }
  }
  return entries;
}

/** OpenCode `GET /session/:id/message`. */
function opencodeEntries(data: Json): Entry[] {
  const entries: Entry[] = [];
  for (const message of (data.messages ?? []) as Json[]) {
    const role = (message.info as Json | undefined)?.role === "user" ? "user" : "assistant";
    for (const part of (message.parts ?? []) as Json[]) {
      if (part.type === "text" && part.text && !part.synthetic)
        entries.push({ role, text: String(part.text) });
      if (part.type === "tool")
        entries.push({
          role: "tool",
          text: toolLine(String(part.tool), (part.state as Json | undefined)?.input),
        });
    }
  }
  return entries;
}

export function entries(harness: string, data: Json): Entry[] {
  const list =
    harness === "codex"
      ? codexEntries(data)
      : harness === "claude"
        ? claudeEntries(data)
        : opencodeEntries(data);
  return list
    .map((e) => ({ ...e, text: e.text.replace(PREAMBLE, "").trim() }))
    .filter((e) => e.text);
}

/** The conversation as text: the latest `last` messages and steps. */
export function transcript(harness: string, data: Json, last = 40) {
  const list = entries(harness, data);
  const shown = list.slice(-Math.min(Math.max(1, last), 200));
  const lines = shown.map((e) =>
    e.role === "tool" ? `  · ${e.text}` : `${e.role.toUpperCase()}: ${clip(e.text, 4000)}`,
  );
  const head =
    shown.length < list.length ? [`(${list.length - shown.length} earlier entries left out)`] : [];
  return clip([...head, ...lines].join("\n\n"), LIMIT);
}

/**
 * The answer a delegated task returns: what the conversation said after the task's message,
 * so an earlier reply is never passed off as this one. Null when the message is not there.
 */
export function answerTo(harness: string, data: Json, task: string) {
  const list = entries(harness, data);
  const asked = list.findLastIndex((e) => e.role === "user" && e.text.includes(taskMark(task)));
  if (asked < 0) return null;
  return list.slice(asked + 1).findLast((e) => e.role === "assistant")?.text ?? "";
}

const taskMark = (task: string) => `[Writer delegated task ${task} from`;
export const delegatedPrompt = (task: string, from: string, prompt: string) =>
  `${taskMark(task)} conversation ${from}]\nDo the task below in this project and give the result directly; Writer sends your final answer back to the conversation that asked. Do not call writer_delegate yourself, and keep everyone else's changes.\n\n${prompt}`;

export const resultPrompt = (task: string, from: string, answer: string, failed: boolean) =>
  `[Writer delegated task ${task}: ${failed ? "failed" : "result"} from conversation ${from}]\n${
    failed
      ? "The delegated task could not be completed:"
      : "The conversation you delegated to answered:"
  }\n\n${clip(answer || "(no answer)", 20_000)}\n\nCheck this result as evidence, then continue the user's task.`;
