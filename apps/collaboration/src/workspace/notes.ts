/**
 * The comment being written, and turning a selection on the compiled PDF into a comment on the
 * source: SyncTeX names the lines, then the PDF's words are looked up in those lines.
 */
import type { PdfDraft } from "@lmms-lab/workbench";
import { useEffect, useState } from "react";
import type { CommentPdf, FileContent, FileInfo, SourceLocation } from "../../shared/api";
import { api } from "../api";

/** A new comment: from an editor selection (relative positions) or from offsets (the PDF). */
export type CommentDraft = {
  file: string;
  quote: string;
  body: string;
  from: number;
  to: number;
  start?: string;
  end?: string;
  /** Source text at `from…to` when the draft was made from offsets. */
  excerpt?: string;
  pdf?: CommentPdf;
};

/** Survives reloads (per user and project); an unusable stored value is ignored. */
export function useDraft(key: string, report: (message: string) => void, failed: string) {
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved && typeof saved.file === "string" && typeof saved.body === "string")
        setDraft(saved);
    } catch {}
  }, [key]);
  useEffect(() => {
    try {
      if (draft) localStorage.setItem(key, JSON.stringify(draft));
      else localStorage.removeItem(key);
    } catch {
      report(failed);
    }
  }, [draft, key, report, failed]);
  return [draft, setDraft] as const;
}

export function postDraft(prefix: string, draft: CommentDraft) {
  return draft.start && draft.end
    ? api(`${prefix}/comments`, {
        file: draft.file,
        start: draft.start,
        end: draft.end,
        quote: draft.quote,
        body: draft.body,
      })
    : api(`${prefix}/comments`, {
        file: draft.file,
        from: draft.from,
        to: draft.to,
        excerpt: draft.excerpt ?? "",
        quote: draft.quote,
        body: draft.body,
        pdf: draft.pdf,
      });
}

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

/** Map a PDF selection to source offsets through SyncTeX on the build it was made on. */
export async function draftFromPdf(
  prefix: string,
  build: string,
  files: FileInfo[],
  selection: PdfDraft,
  currentText: (file: FileInfo) => string | null,
): Promise<CommentDraft> {
  const ends = [selection.marks[0], selection.marks.at(-1)];
  const [start, end] = await Promise.all(
    ends.map((mark) =>
      mark
        ? api<SourceLocation>(
            `${prefix}/builds/${build}/inverse?page=${mark.page}&x=${(mark.x + mark.width / 2) * mark.pageWidth}&y=${(mark.y + mark.height / 2) * mark.pageHeight}`,
          )
        : Promise.reject(new Error("no selection")),
    ),
  );
  if (!start || !end) throw new Error("no selection");
  const file = files.find((f) => f.path === start.file && !f.binary);
  if (!file) throw new Error(start.file);
  let source = currentText(file);
  if (source === null) {
    const saved = await api<FileContent>(`${prefix}/files/${file.id}`);
    source = "content" in saved ? saved.content : "";
  }
  const lastLine = end.file === start.file && end.line >= start.line ? end.line : start.line;
  const { from, to } = locateQuote(source, selection.quote, start.line, lastLine);
  return {
    file: file.id,
    quote: selection.quote,
    body: selection.comment,
    from,
    to,
    excerpt: source.slice(from, to),
    pdf: {
      fingerprint: selection.fingerprint,
      style: selection.style,
      marks: selection.marks.map(({ page, x, y, width, height }) => ({
        page,
        x,
        y,
        width,
        height,
      })),
    },
  };
}
