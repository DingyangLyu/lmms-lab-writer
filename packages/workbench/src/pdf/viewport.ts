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
