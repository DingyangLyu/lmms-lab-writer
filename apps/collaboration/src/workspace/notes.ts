/**
 * The comment being written, and turning a selection on the compiled PDF into a comment on the
 * source: SyncTeX names the lines, then the PDF's words are looked up in those lines.
 */
import { locateQuote, type PdfDraft } from "@lmms-lab/workbench";
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

/** Which conversation each comment was last handed to, and when (this browser). */
export type SentNotes = Record<string, { to: string; at: number }>;
export function useSentNotes(project: string) {
  const key = `writer-note-sent:${project}`;
  const [sent, setSent] = useState<SentNotes>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "{}");
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  });
  const mark = (ids: string[], to: string) =>
    setSent((current) => {
      const next = { ...current };
      for (const id of ids) next[id] = { to, at: Date.now() };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Remembered for this visit only. */
      }
      return next;
    });
  return [sent, mark] as const;
}
