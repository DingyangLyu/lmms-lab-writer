import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { i18n } from "./i18n";

GlobalWorkerOptions.workerSrc = workerUrl;

export type Highlight = { page: number; x: number; y: number; width: number; height: number };
type PageSize = { width: number; height: number };

/**
 * Renders every page to a canvas sized to the panel width. Coordinates passed in and out
 * are PDF points from the page's top-left corner, matching the SyncTeX endpoints.
 */
export function PdfViewer({
  url,
  highlight,
  onInverse,
}: {
  url: string;
  highlight: Highlight | null;
  onInverse: (page: number, x: number, y: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [sizes, setSizes] = useState<PageSize[]>([]),
    [width, setWidth] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const task = getDocument({ url, isEvalSupported: false, withCredentials: true });
    void task.promise
      .then(async (doc) => {
        const pages: PageSize[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const [, , w, h] = (await doc.getPage(i)).view;
          pages.push({ width: w ?? 612, height: h ?? 792 });
        }
        if (disposed) return;
        setSizes(pages);
        setPdf(doc);
        setError("");
      })
      .catch((e) => {
        if (!disposed) setError(i18n.t("pdf.failed", { error: String(e) }));
      });
    return () => {
      disposed = true;
      void task.destroy();
    };
  }, [url]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(200, Math.floor((entry?.contentRect.width ?? 600) - 24))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!highlight) return;
    host.current
      ?.querySelector(`[data-page="${highlight.page}"] .pdf-highlight`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight]);
  return (
    <div className="pdf-viewer" ref={host}>
      {error && <p className="error">{error}</p>}
      {pdf &&
        width > 0 &&
        sizes.map((size, i) => (
          <PdfPage
            // biome-ignore lint/suspicious/noArrayIndexKey: Pages of one immutable PDF.
            key={`${url}:${i}`}
            pdf={pdf}
            number={i + 1}
            scale={width / size.width}
            size={size}
            highlight={highlight?.page === i + 1 ? highlight : null}
            onInverse={onInverse}
          />
        ))}
    </div>
  );
}

function PdfPage({
  pdf,
  number,
  scale,
  size,
  highlight,
  onInverse,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  scale: number;
  size: PageSize;
  highlight: Highlight | null;
  onInverse: (page: number, x: number, y: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(number <= 2);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    // Only render pages near the viewport; long papers stay responsive.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVisible(true);
      },
      { rootMargin: "800px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !canvas.current) return;
    const target = canvas.current;
    let cancelled = false;
    let render: { cancel: () => void } | null = null;
    void pdf.getPage(number).then((page) => {
      if (cancelled) return;
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * ratio });
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      const task = page.render({ canvas: target, viewport });
      render = task;
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [pdf, number, scale, visible]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The pointer position on the rendered page is the input; keyboard users jump with the editor's find-in-PDF button and the issue list.
    <div
      className="pdf-page"
      data-page={number}
      ref={box}
      style={{ width: size.width * scale, height: size.height * scale }}
      onDoubleClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onInverse(number, (e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
      }}
      title={i18n.t("pdf.inverseTitle")}
    >
      <canvas ref={canvas} style={{ width: "100%", height: "100%" }} />
      {highlight && (
        <div
          className="pdf-highlight"
          style={{
            left: highlight.x * scale - 2,
            top: highlight.y * scale - 2,
            width: highlight.width * scale + 4,
            height: highlight.height * scale + 4,
          }}
        />
      )}
    </div>
  );
}
