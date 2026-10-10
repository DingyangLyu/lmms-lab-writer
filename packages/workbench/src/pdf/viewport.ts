/** CSS pixel width available to a PDF page; real PDF dimensions come from PDF.js. */
export function fitPageWidth(
  clientWidth: number,
  paddingLeft: number,
  paddingRight: number,
): number {
  return Math.max(1, Math.floor(clientWidth - paddingLeft - paddingRight));
}
export function pageScale(renderedWidth: number, naturalWidth: number): number {
  return naturalWidth > 0 ? renderedWidth / naturalWidth : 1;
}
export function viewportAnchor(scrollTop: number, pageTop: number, pageHeight: number) {
  return pageHeight > 0 ? Math.max(0, Math.min(1, (scrollTop - pageTop) / pageHeight)) : 0;
}
/**
 * How far down its page a link's destination is (0 is the top), from the explicit
 * destination PDF.js resolves: `[page, {name: "XYZ"}, left, top, zoom]`, `FitH`/`FitBH` with
 * a top, `FitR` with a rectangle; PDF coordinates count up from the bottom.
 */
export function destinationFraction(dest: unknown, pageHeight: number) {
  if (!Array.isArray(dest) || !pageHeight) return 0;
  const name = (dest[1] as { name?: string } | undefined)?.name;
  const top =
    name === "XYZ"
      ? dest[3]
      : name === "FitH" || name === "FitBH"
        ? dest[2]
        : name === "FitR"
          ? dest[5]
          : null;
  return typeof top === "number" ? Math.min(1, Math.max(0, 1 - top / pageHeight)) : 0;
}
