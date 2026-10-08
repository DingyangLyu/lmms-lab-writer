import { i18n } from "@/lib/i18n";
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
export function collectSelection(
  container: HTMLElement,
  scale: number,
): { quote: string; marks: PdfMark[] } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const marks: PdfMark[] = [];
  const quoted: string[] = [];
  for (const element of Array.from(container.querySelectorAll<HTMLElement>("[data-pdf-page]"))) {
    const textLayer = element.querySelector(".react-pdf__Page__textContent");
    if (!textLayer || !range.intersectsNode(textLayer)) continue;
    const pageRect = element.getBoundingClientRect();
    const naturalWidth = Number(element.dataset.pdfWidth);
    const actualScale = naturalWidth > 0 ? pageRect.width / naturalWidth : scale;
    const walker = container.ownerDocument.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    const pageText: string[] = [];
    let node: Node | null = walker.nextNode();
    while (node) {
      if (node.textContent?.trim() && range.intersectsNode(node)) {
        const start = range.startContainer === node ? range.startOffset : 0;
        const end = range.endContainer === node ? range.endOffset : node.textContent.length;
        if (start < end) {
          const textRange = container.ownerDocument.createRange();
          textRange.setStart(node, start);
          textRange.setEnd(node, end);
          pageText.push(textRange.toString());
          // Element ranges include page/canvas/container rectangles on WebKit.
          // A range contained in one text node produces only the selected glyphs.
          for (const rect of Array.from(textRange.getClientRects())) {
            const mark = normalizeRect(
              rect,
              pageRect,
              Number(element.dataset.pdfPage),
              actualScale,
            );
            if (mark && !marks.some((m) => sameMark(m, mark))) marks.push(mark);
          }
        }
      }
      node = walker.nextNode();
    }
    if (pageText.length) quoted.push(pageText.join(" "));
  }
  const quote = quoted.join("\n").trim();
  return quote && marks.length ? { quote, marks: marks.slice(0, 200) } : null;
}
function sameMark(a: PdfMark, b: PdfMark) {
  return (
    a.page === b.page &&
    Math.abs(a.x - b.x) < 0.0001 &&
    Math.abs(a.y - b.y) < 0.0001 &&
    Math.abs(a.width - b.width) < 0.0001 &&
    Math.abs(a.height - b.height) < 0.0001
  );
}
/** Older cross-page captures contain full-page element boxes alongside valid text boxes. */
export function visibleTextMarks(marks: PdfMark[]): PdfMark[] {
  return marks.filter((mark) => !(mark.width > 0.8 && mark.height > 0.25));
}

export function annotationPrompt(
  ids: string[],
  backend: import("@/lib/harness/types").HarnessId,
): string {
  return i18n.t("msg.annotationPrompt", { ids: JSON.stringify(ids), backend });
}
