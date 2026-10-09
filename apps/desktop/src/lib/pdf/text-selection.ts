/**
 * Drag selection in the PDF preview. Browsers place a selection end that lands on
 * blank space (page margins, the grey gutter, the gap between pages) at an
 * arbitrary point of the text layer, which on a cross-page drag selects whole
 * pages or drops the start of the selection. Here both ends always snap to the
 * nearest text, the same way in WebKit and Chromium.
 */
export type Box = { left: number; top: number; right: number; bottom: number };
type Caret = { node: Text; offset: number };

/** Boxes within this many pixels of the nearest one count as the same line. */
const LINE_TOLERANCE = 3;
const DRAG_THRESHOLD = 3;
const SCROLL_EDGE = 32;

/** Index of the box a point belongs to: the nearest line first, then the nearest box on it. */
export function nearestBox(boxes: Box[], x: number, y: number): number {
  const dy = boxes.map((box) => Math.max(0, box.top - y, y - box.bottom));
  const closest = Math.min(...dy);
  let best = -1,
    bestDx = Infinity;
  boxes.forEach((box, index) => {
    if ((dy[index] ?? Infinity) > closest + LINE_TOLERANCE) return;
    const dx = Math.max(0, box.left - x, x - box.right);
    if (dx < bestDx) {
      best = index;
      bestDx = dx;
    }
  });
  return best;
}

/** Whether a point maps to the start or end of a box, or falls inside it. */
export function sideOf(box: Box, x: number, y: number): "start" | "end" | "inside" {
  if (y < box.top) return "start";
  if (y > box.bottom) return "end";
  if (x <= box.left) return "start";
  if (x >= box.right) return "end";
  return "inside";
}

/** Caret offset in a left-to-right run: before the first character whose centre is right of x. */
export function offsetAt(
  length: number,
  x: number,
  measure: (index: number) => { left: number; right: number },
): number {
  let low = 0,
    high = length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const box = measure(middle);
    if ((box.left + box.right) / 2 < x) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The word around an offset, for double-click selection. */
export function wordAt(text: string, offset: number): [number, number] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) {
      const end = part.index + part.segment.length;
      if (offset < end || end === text.length) return [part.index, end];
    }
    return [offset, offset];
  }
  const word = /[\p{L}\p{N}_]/u;
  let start = Math.min(offset, text.length),
    end = start;
  while (start > 0 && word.test(text[start - 1] ?? "")) start--;
  while (end < text.length && word.test(text[end] ?? "")) end++;
  return start === end ? [offset, Math.min(text.length, offset + 1)] : [start, end];
}

function textRuns(page: HTMLElement): Array<{ node: Text; box: DOMRect }> {
  const runs: Array<{ node: Text; box: DOMRect }> = [];
  for (const span of page.querySelectorAll<HTMLElement>(
    ".react-pdf__Page__textContent span[role='presentation']",
  )) {
    const node = span.firstChild;
    if (!(node instanceof Text) || !node.length) continue;
    const box = span.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) runs.push({ node, box });
  }
  return runs;
}

/** The text position a point snaps to, or null while no page has rendered text. */
export function caretAtPoint(container: HTMLElement, clientX: number, clientY: number) {
  const view = container.getBoundingClientRect();
  // Never reach text scrolled out of view behind surrounding panels.
  const x = Math.min(Math.max(clientX, view.left), view.right),
    y = Math.min(Math.max(clientY, view.top), view.bottom);
  let best: { runs: Array<{ node: Text; box: DOMRect }>; distance: number } | null = null;
  for (const page of container.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
    const box = page.getBoundingClientRect();
    const distance = Math.max(0, box.top - y, y - box.bottom);
    if (best && distance >= best.distance) continue;
    const runs = textRuns(page);
    if (runs.length) best = { runs, distance };
  }
  if (!best) return null;
  const run =
    best.runs[
      nearestBox(
        best.runs.map((r) => r.box),
        x,
        y,
      )
    ];
  if (!run) return null;
  const side = sideOf(run.box, x, y);
  if (side !== "inside") return { node: run.node, offset: side === "start" ? 0 : run.node.length };
  const range = run.node.ownerDocument.createRange();
  const offset = offsetAt(run.node.length, x, (index) => {
    range.setStart(run.node, index);
    range.setEnd(run.node, index + 1);
    return range.getBoundingClientRect();
  });
  return { node: run.node, offset } satisfies Caret;
}

/**
 * Take over mouse selection inside `container`. `onSelected` runs after a drag,
 * double-click or triple-click leaves a selection. Returns a cleanup function.
 */
export function attachPdfSelection(container: HTMLElement, onSelected: () => void): () => void {
  const document = container.ownerDocument;
  let stop: (() => void) | null = null;
  const begin = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest("a, button, input, select, textarea, [contenteditable]")) return;
    const view = container.getBoundingClientRect();
    // Leave the scroll bars to the browser.
    if (
      event.clientX >= view.left + container.clientLeft + container.clientWidth ||
      event.clientY >= view.top + container.clientTop + container.clientHeight
    )
      return;
    const selection = document.getSelection();
    const start = caretAtPoint(container, event.clientX, event.clientY);
    if (!selection || !start) return;
    event.preventDefault();
    // preventDefault keeps focus where it was; release it so copying takes the PDF text.
    const active = document.activeElement;
    if (active instanceof HTMLElement && !container.contains(active)) active.blur();
    stop?.();
    let anchor: Caret = start;
    if (event.shiftKey && selection.rangeCount && selection.anchorNode instanceof Text) {
      if (container.contains(selection.anchorNode))
        anchor = { node: selection.anchorNode, offset: selection.anchorOffset };
    }
    let point = { x: event.clientX, y: event.clientY },
      dragging = event.shiftKey,
      frame = 0;
    if (event.detail >= 2) {
      const [from, to] =
        event.detail === 2 ? wordAt(start.node.data, start.offset) : [0, start.node.length];
      selection.setBaseAndExtent(start.node, from, start.node, to);
      onSelected();
      return;
    }
    if (!dragging) selection.removeAllRanges();
    const extend = () => {
      if (!anchor.node.isConnected) return;
      const focus = caretAtPoint(container, point.x, point.y);
      if (focus) selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    };
    if (dragging) extend();
    // Dragging against the top or bottom edge scrolls, as native selection does.
    const scroll = () => {
      frame = 0;
      const box = container.getBoundingClientRect();
      const speed =
        point.y < box.top + SCROLL_EDGE
          ? point.y - (box.top + SCROLL_EDGE)
          : point.y > box.bottom - SCROLL_EDGE
            ? point.y - (box.bottom - SCROLL_EDGE)
            : 0;
      if (!speed) return;
      container.scrollTop += Math.max(-40, Math.min(40, speed / 2));
      extend();
      frame = requestAnimationFrame(scroll);
    };
    const move = (next: MouseEvent) => {
      point = { x: next.clientX, y: next.clientY };
      if (
        !dragging &&
        Math.hypot(point.x - event.clientX, point.y - event.clientY) < DRAG_THRESHOLD
      )
        return;
      dragging = true;
      extend();
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const finish = (selected: boolean) => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      window.removeEventListener("blur", cancel);
      stop = null;
      if (selected && !selection.isCollapsed) onSelected();
    };
    const up = () => finish(dragging);
    const cancel = () => finish(false);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    window.addEventListener("blur", cancel);
    stop = cancel;
  };
  container.addEventListener("mousedown", begin);
  return () => {
    container.removeEventListener("mousedown", begin);
    stop?.();
  };
}
