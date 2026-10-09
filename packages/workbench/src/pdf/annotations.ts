export type PdfMark = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
};
export type AnnotationSource = {
  file: string;
  line: number;
  endLine: number;
  context: string;
  method: string;
};
export type AnnotationEvent = {
  id: string;
  action: string;
  timestamp: number;
  comment: string;
  resolution: string;
  resolved: boolean;
  gitHash?: string | null;
};
export type PdfAnnotation = {
  kind?: "pdf" | "text";
  anchor?: {
    file: string;
    revision: string;
    ranges: Array<{ start: number; end: number; text: string }>;
  } | null;
  id: string;
  pdf: string;
  quote: string;
  comment: string;
  style: "highlight" | "underline";
  marks: PdfMark[];
  fingerprint: string;
  createdAt: number;
  resolved: boolean;
  source: AnnotationSource | null;
  mappingNote: string;
  resolution: string;
  events?: AnnotationEvent[];
  submittedTo?: string | null;
};
export function normalizeRect(
  rect: { left: number; top: number; right: number; bottom: number },
  page: { left: number; top: number; width: number; height: number },
  pageNumber: number,
  scale: number,
): PdfMark | null {
  const left = Math.max(rect.left, page.left),
    right = Math.min(rect.right, page.left + page.width),
    top = Math.max(rect.top, page.top),
    bottom = Math.min(rect.bottom, page.top + page.height);
  if (right - left < 1 || bottom - top < 1 || page.width <= 0 || page.height <= 0) return null;
  return {
    page: pageNumber,
    x: (left - page.left) / page.width,
    y: (top - page.top) / page.height,
    width: (right - left) / page.width,
    height: (bottom - top) / page.height,
    pageWidth: page.width / scale,
    pageHeight: page.height / scale,
  };
}
/** The backend accepts at most this many rectangles per annotation. */
export const MAX_MARKS = 200;
export function collectSelection(
  container: HTMLElement,
  scale: number,
): { quote: string; marks: PdfMark[] } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const marks: PdfMark[] = [];
  const lines: string[] = [];
  for (const element of Array.from(container.querySelectorAll<HTMLElement>("[data-pdf-page]"))) {
    const textLayer = element.querySelector(".react-pdf__Page__textContent");
    if (!textLayer || !range.intersectsNode(textLayer)) continue;
    const pageRect = element.getBoundingClientRect();
    const naturalWidth = Number(element.dataset.pdfWidth);
    const actualScale = naturalWidth > 0 ? pageRect.width / naturalWidth : scale;
    // PDF.js ends each text line with a <br>; the text runs carry their own spaces.
    const walker = container.ownerDocument.createTreeWalker(
      textLayer,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    );
    let line = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!range.intersectsNode(node)) continue;
      if (node.nodeName === "BR") {
        lines.push(line);
        line = "";
      }
      if (!(node instanceof Text)) continue;
      const start = range.startContainer === node ? range.startOffset : 0;
      const end = range.endContainer === node ? range.endOffset : node.length;
      if (start >= end) continue;
      const textRange = container.ownerDocument.createRange();
      textRange.setStart(node, start);
      textRange.setEnd(node, end);
      const text = textRange.toString();
      line += text;
      if (!text.trim()) continue;
      // Element ranges include page/canvas/container rectangles on WebKit.
      // A range contained in one text node produces only the selected glyphs.
      for (const rect of Array.from(textRange.getClientRects())) {
        const mark = normalizeRect(rect, pageRect, Number(element.dataset.pdfPage), actualScale);
        if (mark) marks.push(mark);
      }
    }
    lines.push(line);
  }
  const quote = joinLines(lines);
  return quote && marks.length ? { quote, marks: mergeMarks(marks) } : null;
}
/** Text lines as running text; a word hyphenated at a line end is joined again. */
export function joinLines(lines: string[]): string {
  let text = "";
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    text = !text ? line : /\p{L}-$/u.test(text) ? text + line : `${text} ${line}`;
  }
  return text;
}
/** Joins neighbouring rectangles on one line, so a long selection stays a few marks per line. */
export function mergeMarks(marks: PdfMark[]): PdfMark[] {
  const merged: PdfMark[] = [];
  for (const mark of marks) {
    const last = merged.at(-1);
    if (!last || !sameLine(last, mark)) {
      merged.push({ ...mark });
      continue;
    }
    const left = Math.min(last.x, mark.x),
      top = Math.min(last.y, mark.y),
      right = Math.max(last.x + last.width, mark.x + mark.width),
      bottom = Math.max(last.y + last.height, mark.y + mark.height);
    Object.assign(last, { x: left, y: top, width: right - left, height: bottom - top });
  }
  return merged;
}
function sameLine(a: PdfMark, b: PdfMark) {
  if (a.page !== b.page) return false;
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (overlap < Math.min(a.height, b.height) / 2) return false;
  const gap = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width)) * a.pageWidth;
  return gap <= 1.5 * Math.max(a.height, b.height) * a.pageHeight;
}
/** Older cross-page captures contain full-page element boxes alongside valid text boxes. */
export function visibleTextMarks(marks: PdfMark[]): PdfMark[] {
  return marks.filter((mark) => !(mark.width > 0.8 && mark.height > 0.25));
}
