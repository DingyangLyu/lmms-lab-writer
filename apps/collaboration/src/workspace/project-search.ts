/**
 * Find and replace across the project's text files: the pattern from the switches (case,
 * regular expression, whole word, as in the editor's own search), every match with its line
 * for the list, and the replaced text of a file.
 */
export type SearchOptions = {
  query: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
};
export type SearchMatch = {
  line: number;
  /** Offsets in the file. */
  from: number;
  to: number;
  /** The line around the match, and where the match is within it. */
  preview: string;
  at: number;
  length: number;
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Letters, digits and underscore count as a word, in any script. */
const WORD = "[\\p{L}\\p{N}_]";

/** The pattern to search with; null for an empty query; an Error for a broken expression. */
export function searchPattern(options: SearchOptions): RegExp | Error | null {
  if (!options.query) return null;
  const body = options.regexp ? options.query : escapeRegExp(options.query);
  const source = options.wholeWord ? `(?<!${WORD})(?:${body})(?!${WORD})` : body;
  try {
    return new RegExp(source, `gmu${options.caseSensitive ? "" : "i"}`);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const PREVIEW = 48;

/** Every match in `text`, up to `limit`; empty matches are skipped. */
export function findMatches(text: string, pattern: RegExp, limit = 1000): SearchMatch[] {
  const matches: SearchMatch[] = [];
  pattern.lastIndex = 0;
  let line = 1,
    counted = 0;
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    if (!found[0]) {
      pattern.lastIndex++;
      continue;
    }
    const from = found.index,
      to = from + found[0].length;
    for (let i = text.indexOf("\n", counted); i >= 0 && i < from; i = text.indexOf("\n", i + 1)) {
      line++;
      counted = i + 1;
    }
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    const lineEnd = (() => {
      const end = text.indexOf("\n", from);
      return end < 0 ? text.length : end;
    })();
    const start = Math.max(lineStart, from - PREVIEW);
    const end = Math.min(lineEnd, Math.max(to, from) + PREVIEW);
    const lead = start > lineStart ? "…" : "";
    matches.push({
      line,
      from,
      to,
      preview: `${lead}${text.slice(start, end)}${end < lineEnd ? "…" : ""}`,
      at: lead.length + from - start,
      length: Math.min(to, end) - from,
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

/**
 * The text with every match replaced: `$1`, `$<name>`, `$&` and the like work with regular
 * expressions; otherwise the replacement is taken literally. Empty matches are left alone.
 */
export function replaceAll(text: string, pattern: RegExp, replacement: string, regexp: boolean) {
  let count = 0;
  pattern.lastIndex = 0;
  const content = text.replace(pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    if (!match) return match;
    count++;
    if (!regexp) return replacement;
    const named = typeof args.at(-1) === "object" ? (args.at(-1) as Record<string, string>) : null;
    const at = named ? args.length - 3 : args.length - 2;
    const captures = args.slice(1, at) as Array<string | undefined>;
    const offset = args[at] as number;
    return replacement.replace(
      /\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g,
      (token, what: string, name: string | undefined) => {
        if (what === "$") return "$";
        if (what === "&") return match;
        if (what === "`") return text.slice(0, offset);
        if (what === "'") return text.slice(offset + match.length);
        if (name !== undefined) return named?.[name] ?? "";
        const n = Number(what);
        return n >= 1 && n <= captures.length ? (captures[n - 1] ?? "") : token;
      },
    );
  });
  return { content, count };
}
