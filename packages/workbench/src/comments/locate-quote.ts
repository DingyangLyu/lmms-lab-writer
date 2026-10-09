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
    // Ligatures and macros can change the middle; anchor on both ends instead.
    const head = words.slice(0, 12),
      tail = words.slice(-12);
    const a = find(head),
      z = a >= 0 ? region.flat.indexOf(tail, a) : -1;
    if (a >= 0 && z >= 0) {
      start = a;
      end = z + tail.length - 1;
    }
  }
  if (start < 0) {
    // A citation or formula at the end ("[1]" for \cite{…}): keep the longest opening that matches.
    let length = 0;
    const limit = Math.min(words.length, 240);
    while (length < limit && region.flat.includes(words.slice(0, length + 1))) length++;
    if (length >= 6) {
      start = find(words.slice(0, length));
      end = start + length - 1;
    }
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
