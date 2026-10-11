/**
 * Text selected on a compiled PDF, found again in its LaTeX source: SyncTeX names the lines,
 * and the words are matched there ignoring spacing, TeX commands and line-end hyphens.
 */
/** Characters that carry the words: no spaces, no TeX syntax, no line-end hyphens. */
const significant = (c: string) => !/[\s{}\\$%~^_&#-]/.test(c);

/** The text with only significant characters, and where each one came from. */
function skeleton(text: string, offset = 0) {
  let flat = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    // Skip a TeX command's name (\emph, \cite) but keep its argument's words.
    if (text[i] === "\\") {
      let j = i + 1;
      while (j < text.length && /[a-zA-Z@]/.test(text[j] ?? "")) j++;
      i = Math.max(i, j - 1);
      continue;
    }
    const c = text[i] ?? "";
    if (!significant(c)) continue;
    flat += c;
    at.push(offset + i);
  }
  return { flat, at };
}

/**
 * Where `quote` (text from the PDF) sits in `source` between two 1-based lines, as offsets.
 * The quote's words are matched ignoring spacing and TeX commands; if they cannot be found,
 * the comment covers the whole lines.
 */
export function locateQuote(source: string, quote: string, firstLine: number, lastLine: number) {
  const lines = source.split("\n");
  const lineStart = (line: number) =>
    lines.slice(0, Math.max(0, line - 1)).reduce((n, l) => n + l.length + 1, 0);
  const first = Math.max(1, Math.min(firstLine, lines.length));
  const last = Math.max(first, Math.min(lastLine, lines.length));
  // Look a little around the lines SyncTeX named; it often points one line off.
  const regionStart = lineStart(Math.max(1, first - 2));
  const regionEnd = Math.min(source.length, lineStart(Math.min(lines.length, last + 2) + 1));
  const region = skeleton(source.slice(regionStart, regionEnd), regionStart);
  const words = skeleton(quote).flat;
  const find = (needle: string) => (needle.length >= 4 ? region.flat.indexOf(needle) : -1);
  let start = find(words);
  let end = start >= 0 ? start + words.length - 1 : -1;
  if (start < 0) {
    // Section numbers, citation numbers and formulas ("1 Introduction", "[1, 2]") are not in the
    // source: anchor on the first stretch of the quote that is, and the last one after it, so a
    // selection over several paragraphs keeps all of them.
    const span = matchEnds(region.flat, words);
    if (span) [start, end] = span;
  }
  if (start >= 0 && end >= start) {
    const from = region.at[start] ?? 0,
      to = (region.at[end] ?? from) + 1;
    return { from, to, exact: true };
  }
  const from = lineStart(first),
    to = lineStart(last) + (lines[last - 1]?.length ?? 0);
  // Leave out the lines' indentation.
  const text = source.slice(from, to);
  const lead = text.length - text.trimStart().length,
    trail = text.length - text.trimEnd().length;
  return { from: from + lead, to: Math.max(from + lead + 1, to - trail), exact: false };
}

/** The longest stretch of the quote matched at a time when its ends are looked for, and the shortest. */
const WINDOW = 12,
  SHORTEST = 6;
/** How far into the quote, from either end, unmatched characters are skipped. */
const SKIP = 400;

/** Where the quote's first and last matching stretches sit in `flat`, as indices. */
function matchEnds(flat: string, words: string): [number, number] | null {
  const shortest = Math.min(SHORTEST, words.length);
  if (shortest < 4) return null;
  let head = -1;
  for (let k = 0; k + shortest <= words.length && k <= SKIP && head < 0; k++)
    for (let size = Math.min(WINDOW, words.length - k); size >= shortest && head < 0; size--)
      head = flat.indexOf(words.slice(k, k + size));
  if (head < 0) return null;
  for (let k = words.length; k - shortest >= 0 && words.length - k <= SKIP; k--)
    for (let size = Math.min(WINDOW, k); size >= shortest; size--) {
      const at = flat.indexOf(words.slice(k - size, k), head);
      if (at >= 0) return [head, at + size - 1];
    }
  return null;
}
