import { workbenchI18n as i18n } from "../i18n";
export type OutlineEntry = {
  id: string;
  title: string;
  line: number;
  kind: "section" | "figure" | "table" | "include";
  level: number;
  target?: string;
  children: OutlineEntry[];
};

const levels: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};
const escaped = (text: string, at: number) => {
  let count = 0;
  while (at > 0 && text[--at] === "\\") count++;
  return count % 2 === 1;
};
const blank = (text: string) => text.replace(/[^\n\r]/g, " ");

/** Keep offsets/line numbers intact while ignoring commented and literal LaTeX. */
function maskLiterals(source: string) {
  const pattern =
    /%[^\r\n]*|\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}|\\verb\*?([^\sA-Za-z])/g;
  let text = "",
    from = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (escaped(source, match.index)) continue;
    let end = pattern.lastIndex;
    if (match[1]) {
      const closing = new RegExp(`\\\\end\\s*\\{${match[1].replace("*", "\\*")}\\}`, "g");
      closing.lastIndex = end;
      const found = closing.exec(source);
      end = found ? closing.lastIndex : source.length;
    } else if (match[2]) {
      const close = source.indexOf(match[2], end);
      const newline = source.indexOf("\n", end);
      end =
        close >= 0 && (newline < 0 || close < newline)
          ? close + 1
          : newline < 0
            ? source.length
            : newline;
    }
    text += source.slice(from, match.index) + blank(source.slice(match.index, end));
    from = end;
    pattern.lastIndex = end;
  }
  return text + source.slice(from);
}

function argument(source: string, from: number): { text: string; end: number } | null {
  let at = from;
  while (/\s/.test(source[at] || "") && at < source.length) at++;
  if (source[at] === "[") {
    let depth = 1;
    while (++at < source.length && depth) {
      if (!escaped(source, at) && source[at] === "[") depth++;
      if (!escaped(source, at) && source[at] === "]") depth--;
    }
    while (/\s/.test(source[at] || "") && at < source.length) at++;
  }
  if (source[at] !== "{") return null;
  const start = ++at;
  let depth = 1;
  for (; at < source.length; at++) {
    if (!escaped(source, at)) {
      if (source[at] === "{") depth++;
      if (source[at] === "}" && --depth === 0)
        return { text: source.slice(start, at), end: at + 1 };
    }
  }
  return null;
}

const titleText = (text: string) =>
  text
    .replace(/\\(?:label|index)\s*\{[^}]*\}/g, "")
    .replace(/\\[A-Za-z@]+\*?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\\([%&#_$])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

export function latexOutline(source: string): OutlineEntry[] {
  const text = maskLiterals(source);
  const command =
    /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|input|include)\b\*?/g;
  const roots: OutlineEntry[] = [];
  const sections: OutlineEntry[] = [];
  const lineAt = (at: number) => text.slice(0, at).split("\n").length;
  for (let match = command.exec(text); match; match = command.exec(text)) {
    if (escaped(text, match.index)) continue;
    const arg = argument(text, command.lastIndex);
    if (!arg) continue;
    command.lastIndex = arg.end;
    const name = match[1] || "";
    const line = lineAt(match.index);
    let entry: OutlineEntry;
    if (name === "begin") {
      const env = arg.text.trim();
      if (!/^(figure|table)\*?$/.test(env)) continue;
      const kind = env.startsWith("figure") ? "figure" : "table";
      const endPattern = new RegExp(`\\\\end\\s*\\{${env.replace("*", "\\*")}\\}`, "g");
      endPattern.lastIndex = arg.end;
      const end = endPattern.exec(text)?.index ?? text.length;
      const body = text.slice(arg.end, end);
      const caption = /\\caption\b\*?/.exec(body);
      const label = /\\label\b/.exec(body);
      const detail = caption
        ? argument(body, caption.index + caption[0].length)?.text
        : label
          ? argument(body, label.index + label[0].length)?.text
          : "";
      entry = {
        id: `${kind}:${line}`,
        title: `${kind === "figure" ? i18n.t("msg.figure") : i18n.t("msg.table")} · ${titleText(detail || "") || i18n.t("msg.lineNumber", { line })}`,
        line,
        kind,
        level: 7,
        children: [],
      };
      command.lastIndex = end;
    } else if (name === "input" || name === "include") {
      entry = {
        id: `include:${line}`,
        title: arg.text.trim(),
        target: arg.text.trim(),
        line,
        kind: "include",
        level: 7,
        children: [],
      };
    } else {
      const level = levels[name] ?? 2;
      while (sections.length && (sections.at(-1)?.level ?? -1) >= level) sections.pop();
      entry = {
        id: `${name}:${line}`,
        title: titleText(arg.text) || i18n.t("msg.untitledSection"),
        line,
        kind: "section",
        level,
        children: [],
      };
    }
    const parent = sections.at(-1);
    (parent?.children ?? roots).push(entry);
    if (entry.kind === "section") sections.push(entry);
  }
  return roots;
}
