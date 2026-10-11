/**
 * Finding source text in a compiled PDF without compiling again: the PDF's text is read once,
 * page by page, with where each character sits; a comment's words (as LaTeX prints them) are
 * matched in it, and the matched characters become the rectangles to highlight.
 */
import { findSpan, printedSkeleton, significant } from "../comments/locate-quote";
import { mergeMarks, type PdfMark } from "./annotations";

/** A run of text on a page: its characters' left edge, width and line, in page points. */
export type TextRun = { text: string; x: number; width: number; top: number; bottom: number };
export type PageText = { page: number; width: number; height: number; runs: TextRun[] };
/** Every page's significant characters in reading order, and where each one came from. */
export type PdfText = {
  flat: string;
  at: Array<{ page: number; run: number; char: number; of: number }>;
  pages: PageText[];
};

/** What pdf.js gives for a document (only the parts used here). */
type PdfDocument = {
  numPages: number;
  getPage(page: number): Promise<{
    getViewport(options: { scale: number }): { width: number; height: number; transform: number[] };
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
};

const multiply = (m: number[], n: number[]) => {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = m;
  const [g = 0, h = 0, i = 0, j = 0, k = 0, l = 0] = n;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
};

/** A page's text runs from pdf.js text items (horizontal text, page points from the top). */
export function pageRuns(
  items: unknown[],
  viewport: { width: number; height: number; transform: number[] },
): TextRun[] {
  const runs: TextRun[] = [];
  for (const raw of items) {
    const item = raw as { str?: string; transform?: number[]; width?: number };
    if (!item.str || !item.transform) continue;
    const [, , c = 0, d = 0, x = 0, y = 0] = multiply(viewport.transform, item.transform);
    const size = Math.hypot(c, d) || 10;
    runs.push({
      text: item.str,
      x,
      width: item.width ?? 0,
      top: y - size * 0.85,
      bottom: y + size * 0.22,
    });
  }
  return runs;
}

/** Joins pages' runs into one searchable string. */
export function joinPages(pages: PageText[]): PdfText {
  let flat = "";
  const at: PdfText["at"] = [];
  for (const page of pages)
    page.runs.forEach((run, r) => {
      const chars = [...run.text];
      chars.forEach((ch, i) => {
        if (!significant(ch)) return;
        // Ligatures ("ﬁ") count as their letters.
        for (const part of ch.normalize("NFKC")) {
          flat += part;
          at.push({ page: page.page, run: r, char: i, of: chars.length });
        }
      });
    });
  return { flat, at, pages };
}

const cache = new WeakMap<object, Promise<PdfText>>();
/** The document's text, read once. */
export function readPdfText(pdf: PdfDocument): Promise<PdfText> {
  let found = cache.get(pdf);
  if (!found) {
    found = (async () => {
      const pages: PageText[] = [];
      for (let n = 1; n <= Math.min(pdf.numPages, 1000); n++) {
        const page = await pdf.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        const { items } = await page.getTextContent();
        pages.push({
          page: n,
          width: viewport.width,
          height: viewport.height,
          runs: pageRuns(items, viewport),
        });
      }
      return joinPages(pages);
    })();
    cache.set(pdf, found);
  }
  return found;
}

/**
 * The rectangles of `source` (LaTeX, as it is in the file) in the PDF: its `occurrence`-th
 * appearance, or null when it cannot be found (not compiled yet, or rewritten since).
 */
export function locateInPdf(text: PdfText, source: string, occurrence = 0): PdfMark[] | null {
  const needle = printedSkeleton(source);
  if (needle.length < 2) return null;
  const span = findSpan(text.flat, needle, occurrence);
  if (!span) return null;
  // Group the matched characters by the run they are in.
  const marks: PdfMark[] = [];
  let current: { page: number; run: number; from: number; to: number; of: number } | null = null;
  const flush = () => {
    if (!current) return;
    const page = text.pages[current.page - 1];
    const run = page?.runs[current.run];
    if (page && run) {
      const left = run.x + (run.width * current.from) / current.of,
        right = run.x + (run.width * (current.to + 1)) / current.of;
      if (right > left)
        marks.push({
          page: page.page,
          x: Math.max(0, left / page.width),
          y: Math.max(0, run.top / page.height),
          width: Math.min(1, (right - left) / page.width),
          height: Math.min(1, (run.bottom - run.top) / page.height),
          pageWidth: page.width,
          pageHeight: page.height,
        });
    }
    current = null;
  };
  for (let i = span[0]; i <= span[1]; i++) {
    const place = text.at[i];
    if (!place) continue;
    if (current && current.page === place.page && current.run === place.run)
      current.to = Math.max(current.to, place.char);
    else {
      flush();
      current = {
        page: place.page,
        run: place.run,
        from: place.char,
        to: place.char,
        of: place.of,
      };
    }
  }
  flush();
  return marks.length ? mergeMarks(marks) : null;
}
