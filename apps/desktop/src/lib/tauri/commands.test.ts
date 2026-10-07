/**
 * Contract between the frontend's `invoke("name", { args })` calls and the Rust commands
 * registered in src-tauri/src/lib.rs. Tauri resolves both by string at runtime, so a renamed
 * command, a misspelled argument or a dropped parameter only fails when a user clicks.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const desktop = join(import.meta.dirname, "../../..");
const rust = join(desktop, "src-tauri/src");
/** Registered but intentionally not called from the UI. */
const BACKEND_ONLY: Record<string, string> = {
  opencode_stop: "used by opencode_restart and app shutdown",
  read_document_revision: "Writer MCP reads revisions through the same function",
};
const INJECTED = /^(tauri::)?(State|AppHandle|Window|WebviewWindow|Webview)\b/;

type Param = { name: string; required: boolean };
const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Text between the bracket at `open` and its matching closer. */
function enclosed(text: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]", "<": ">" };
  const start = text[open] ?? "";
  const close = pairs[start];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === start) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${start} at ${open}`);
}
/** Splits on commas that are not nested inside brackets (`<>` only for Rust generics). */
function topLevel(list: string, generics = false): string[] {
  const opens = generics ? "([{<" : "([{",
    closes = generics ? ")]}>" : ")]}";
  const parts: string[] = [];
  let depth = 0,
    current = "";
  for (const c of list) {
    if (opens.includes(c)) depth++;
    if (closes.includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function registeredCommands() {
  const lib = readFileSync(join(rust, "lib.rs"), "utf8");
  const start = lib.indexOf("generate_handler![");
  const list = enclosed(lib, lib.indexOf("[", start));
  const commands = new Map<string, Param[]>();
  for (const entry of topLevel(list, true)) {
    const path = entry.split("::");
    const name = path.at(-1) ?? "",
      module = path.at(-2) ?? "";
    const source = readFileSync(join(rust, "commands", `${module}.rs`), "utf8");
    const at = new RegExp(
      `pub(?:\\(crate\\))?\\s+(?:async\\s+)?fn\\s+${name}\\s*(?:<[^(]*>)?\\(`,
    ).exec(source);
    if (!at) throw new Error(`${entry} not found in ${module}.rs`);
    const params = topLevel(enclosed(source, at.index + at[0].length - 1), true)
      .map((p) => /^(?:mut\s+)?(\w+)\s*:\s*([\s\S]+)$/.exec(p))
      .filter((m): m is RegExpExecArray => !!m && !INJECTED.test((m[2] ?? "").trim()))
      .map((m) => ({ name: camel(m[1] ?? ""), required: !/^Option</.test((m[2] ?? "").trim()) }));
    commands.set(name, params);
  }
  return commands;
}

type Call = { command: string; keys: string[] | null; where: string };
function frontendCalls(): Call[] {
  const calls: Call[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
        const text = readFileSync(path, "utf8");
        for (const m of text.matchAll(/\binvoke\s*(?:<[^()]*?>)?\(\s*"([a-z0-9_]+)"\s*(,\s*)?/g)) {
          const line = text.slice(0, m.index).split("\n").length;
          const where = `${relative(desktop, path)}:${line}`;
          const argsAt = (m.index ?? 0) + m[0].length;
          let keys: string[] | null = [];
          if (m[2]) {
            if (text[argsAt] !== "{")
              keys = null; // A variable: cannot be checked statically.
            else {
              const fields = topLevel(enclosed(text, argsAt));
              keys = fields.some((f) => f.startsWith("..."))
                ? null
                : fields.map((f) => (/^(\w+)\s*(:|$)/.exec(f)?.[1] ?? f).trim());
            }
          }
          calls.push({ command: m[1] ?? "", keys, where });
        }
      }
    }
  };
  visit(join(desktop, "src"));
  return calls;
}

describe("Tauri command contract", () => {
  const commands = registeredCommands();
  const calls = frontendCalls();
  it("finds the commands and calls it checks", () => {
    expect(commands.size).toBeGreaterThan(100);
    expect(calls.length).toBeGreaterThan(100);
  });
  it("only invokes registered commands", () => {
    expect(
      calls.filter((c) => !commands.has(c.command)).map((c) => `${c.command} @ ${c.where}`),
    ).toEqual([]);
  });
  it("passes exactly the arguments each command declares", () => {
    const problems: string[] = [];
    for (const call of calls) {
      const params = commands.get(call.command);
      if (!params || !call.keys) continue;
      const names = params.map((p) => p.name);
      for (const key of call.keys)
        if (!names.includes(key))
          problems.push(`${call.where} ${call.command}: unknown argument ${key}`);
      for (const p of params)
        if (p.required && !call.keys.includes(p.name))
          problems.push(`${call.where} ${call.command}: missing ${p.name}`);
    }
    expect(problems).toEqual([]);
  });
  it("registers no command the app never calls", () => {
    const used = new Set(calls.map((c) => c.command));
    expect([...commands.keys()].filter((c) => !used.has(c) && !BACKEND_ONLY[c])).toEqual([]);
  });
});
