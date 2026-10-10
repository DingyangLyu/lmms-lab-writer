"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import { useAnnotations } from "./annotation-bridge";
import { collectSelection, MAX_MARKS, type PdfAnnotation, visibleTextMarks } from "./annotations";
import { attachPdfSelection } from "./text-selection";
import { fitPageWidth, pageScale, viewportAnchor } from "./viewport";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { useWorkbenchI18n as useI18n } from "../i18n";

/** A PDF ready for preview, with any fonts whose text mapping was repaired on the way. */
export type PreparedPdf = { url: string; repairedFonts: string[]; warnings: string[] };
/**
 * The host sets `pdfjs.GlobalWorkerOptions.workerSrc` once (its bundler decides the URL).
 * `prepare` may return a repaired copy of `pdfPath` for reliable text selection.
 */
type Props = {
  src: string;
  goToPage?: number;
  project?: string;
  pdfPath?: string;
  refreshKey?: number;
  prepare?: (pdfPath: string) => Promise<PreparedPdf>;
  /** A region to outline and scroll to, in PDF points from the page's top-left corner. */
  highlight?: PdfRegionBox | null;
  onSynctexClick?: (page: number, x: number, y: number) => void;
};
export type PdfRegionBox = { page: number; x: number; y: number; width: number; height: number };
/** Where a reader was in a project's PDF, and at what zoom: a new build opens at the same place. */
type ReadingPosition = {
  page: number;
  fraction: number;
  zoomMode: "fit" | "manual";
  manualScale: number;
};
const positions = new Map<string, ReadingPosition>();
function readPosition(key: string | null): ReadingPosition | null {
  if (!key) return null;
  const cached = positions.get(key);
  if (cached) return cached;
  try {
    const saved = JSON.parse(localStorage.getItem(`writer-pdf-position:${key}`) || "null");
    if (
      saved &&
      Number.isInteger(saved.page) &&
      saved.page >= 1 &&
      typeof saved.fraction === "number" &&
      (saved.zoomMode === "fit" || saved.zoomMode === "manual") &&
      typeof saved.manualScale === "number"
    ) {
      positions.set(key, saved);
      return saved;
    }
  } catch {
    /* No stored position. */
  }
  return null;
}
function writePosition(key: string, position: ReadingPosition) {
  positions.set(key, position);
  try {
    localStorage.setItem(`writer-pdf-position:${key}`, JSON.stringify(position));
  } catch {
    /* Remembered for this visit only. */
  }
}
export function PdfViewer(props: Props) {
  return <PdfPreview key={`${props.src}:${props.refreshKey ?? 0}`} {...props} />;
}
function PdfPreview({
  src,
  project,
  pdfPath,
  prepare,
  highlight,
  onSynctexClick,
  goToPage,
}: Props) {
  const { t } = useI18n();
  const notes = useAnnotations();
  const [previewSource, setPreviewSource] = useState<string | null>(null);
  const [mappingInfo, setMappingInfo] = useState<{ repairedFonts: string[]; warnings: string[] }>({
    repairedFonts: [],
    warnings: [],
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry rechecks fonts and the PDF source.
  useEffect(() => {
    let cancelled = false;
    setPreviewSource(null);
    setMappingInfo({ repairedFonts: [], warnings: [] });
    const preparing = prepareRef.current;
    if (!project || !pdfPath || !preparing) {
      setPreviewSource(src);
      return;
    }
    void preparing(pdfPath)
      .then((result) => {
        if (!cancelled) {
          setMappingInfo(result);
          setPreviewSource(result.url);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setPreviewSource(src);
          setMappingInfo({
            repairedFonts: [],
            warnings: [t("pdf.checkingThePdfTextMappingFailedError", { error: String(cause) })],
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [src, project, pdfPath, retry]);
  const positionKey = project && pdfPath ? `${project}:${pdfPath}` : null;
  const [saved] = useState(() => readPosition(positionKey));
  const [numPages, setNumPages] = useState(0);
  const [fingerprint, setFingerprint] = useState("");
  const [availableWidth, setAvailableWidth] = useState(0);
  const [zoomMode, setZoomMode] = useState<"fit" | "manual">(saved?.zoomMode ?? "fit");
  const [manualScale, setManualScale] = useState(saved?.manualScale ?? 1);
  /** Every page's size, read when the document loads, so the placeholders are exact. */
  const [pageSizes, setPageSizes] = useState<Map<number, { width: number; height: number }> | null>(
    null,
  );
  const restoredRef = useRef(false);
  const [firstWidth, setFirstWidth] = useState(612);
  const [pixelRatio, setPixelRatio] = useState(1);
  const [mode, setMode] = useState<"read" | "highlight" | "underline">("highlight");
  const [notice, setNotice] = useState<string | null>(null);
  const containerRef = useRef<HTMLElement>(null);
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<{ page: number; fraction: number } | null>(null);
  const widthRef = useRef(0);
  const lastNavigation = useRef<string | null>(null);
  const pagesRef = useRef(new Map<number, { width: number; height: number }>());
  const annotations = useMemo(
    () => notes?.items.filter((note) => note.pdf === pdfPath) ?? [],
    [notes?.items, pdfPath],
  );
  const staleCount = fingerprint
    ? annotations.filter((note) => !note.resolved && note.fingerprint !== fingerprint).length
    : 0;
  const effectiveScale = zoomMode === "fit" ? pageScale(availableWidth, firstWidth) : manualScale;
  const rememberAnchor = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    for (const page of container.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
      const bounds = page.getBoundingClientRect();
      if (bounds.bottom > rect.top) {
        anchorRef.current = {
          page: Number(page.dataset.pdfPage),
          fraction: viewportAnchor(rect.top, bounds.top, bounds.height),
        };
        break;
      }
    }
  }, []);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const css = getComputedStyle(container);
        const width = fitPageWidth(
          container.clientWidth,
          parseFloat(css.paddingLeft) || 0,
          parseFloat(css.paddingRight) || 0,
        );
        if (width !== widthRef.current) {
          rememberAnchor();
          widthRef.current = width;
          setAvailableWidth(width);
        }
        setPixelRatio(window.devicePixelRatio || 1);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      cancelAnimationFrame(frame);
    };
  }, [rememberAnchor]);
  useEffect(() => {
    const resolution = window.matchMedia(`(resolution: ${pixelRatio}dppx)`);
    const changed = () => setPixelRatio(window.devicePixelRatio || 1);
    resolution.addEventListener("change", changed);
    return () => resolution.removeEventListener("change", changed);
  }, [pixelRatio]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore the scroll anchor after React-PDF changes layout in either zoom mode.
  useLayoutEffect(() => {
    if (availableWidth <= 0) return;
    const anchor = anchorRef.current;
    const container = containerRef.current;
    if (!anchor || !container) return;
    const page = container.querySelector<HTMLElement>(`[data-pdf-page="${anchor.page}"]`);
    if (!page) return;
    const outer = container.getBoundingClientRect(),
      rect = page.getBoundingClientRect();
    container.scrollTop += rect.top - outer.top + rect.height * anchor.fraction;
    anchorRef.current = null;
  }, [availableWidth, manualScale, zoomMode]);
  useEffect(
    () => () => {
      if (selectionTimer.current) clearTimeout(selectionTimer.current);
    },
    [],
  );
  // Migrate any old per-PDF composer draft without dropping user text.
  useEffect(() => {
    if (!project || !pdfPath || !notes || notes.draft) return;
    try {
      const key = `writer-pdf-draft:${project}:${pdfPath}`;
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (
        saved &&
        typeof saved.quote === "string" &&
        Array.isArray(saved.marks) &&
        typeof saved.comment === "string"
      ) {
        notes.beginDraft({ ...saved, pdf: pdfPath });
        localStorage.removeItem(key);
      }
    } catch {
      /* Leave invalid legacy storage untouched. */
    }
  }, [project, pdfPath, notes]);
  useEffect(() => {
    const id = notes?.selectedId;
    if (!id || !numPages || !availableWidth) {
      lastNavigation.current = null;
      return;
    }
    const navigationKey = `${id}:${notes?.navigation ?? 0}`;
    if (lastNavigation.current === navigationKey) return;
    const note = annotations.find((note) => note.id === id);
    const mark = note?.marks[0];
    if (!mark) return;
    const page = containerRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${mark.page}"]`);
    if (page && containerRef.current) {
      const container = containerRef.current;
      lastNavigation.current = navigationKey;
      container.scrollTop +=
        page.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        mark.y * page.getBoundingClientRect().height -
        40;
    }
  }, [notes?.selectedId, notes?.navigation, numPages, availableWidth, annotations]);
  useEffect(() => {
    if (!highlight || !numPages || !availableWidth) return;
    const container = containerRef.current;
    const page = container?.querySelector<HTMLElement>(`[data-pdf-page="${highlight.page}"]`);
    const natural = pagesRef.current.get(highlight.page);
    if (!container || !page) return;
    const scale = natural ? page.getBoundingClientRect().height / natural.height : 1;
    container.scrollTop +=
      page.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      (highlight.y + highlight.height / 2) * scale -
      container.clientHeight / 2;
  }, [highlight, numPages, availableWidth]);
  useEffect(() => {
    if (!goToPage || !numPages || !availableWidth) return;
    containerRef.current
      ?.querySelector(`[data-pdf-page="${Math.min(numPages, goToPage)}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [goToPage, numPages, availableWidth]);
  // Back to where the reader was in the previous build, once every page has its real size.
  // A jump the host asked for (SyncTeX, a page) wins.
  useLayoutEffect(() => {
    if (restoredRef.current || !pageSizes || !numPages || availableWidth <= 0) return;
    restoredRef.current = true;
    const container = containerRef.current;
    if (!saved || !container || highlight || goToPage) return;
    const page = container.querySelector<HTMLElement>(
      `[data-pdf-page="${Math.min(saved.page, numPages)}"]`,
    );
    if (!page) return;
    container.scrollTop +=
      page.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      page.getBoundingClientRect().height * saved.fraction;
  }, [pageSizes, numPages, availableWidth, saved, highlight, goToPage]);
  // Remember the place as the reader scrolls or zooms.
  useEffect(() => {
    const container = containerRef.current;
    if (!positionKey || !container) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      timer = null;
      if (!restoredRef.current) return;
      const rect = container.getBoundingClientRect();
      for (const page of container.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
        const bounds = page.getBoundingClientRect();
        if (bounds.bottom > rect.top) {
          writePosition(positionKey, {
            page: Number(page.dataset.pdfPage),
            fraction: viewportAnchor(rect.top, bounds.top, bounds.height),
            zoomMode,
            manualScale,
          });
          return;
        }
      }
    };
    const schedule = () => {
      timer ??= setTimeout(save, 250);
    };
    container.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      container.removeEventListener("scroll", schedule);
      if (timer) clearTimeout(timer);
    };
  }, [positionKey, zoomMode, manualScale]);
  const capture = () => {
    if (!project || !pdfPath || !notes || mode === "read") return;
    if (selectionTimer.current) clearTimeout(selectionTimer.current);
    selectionTimer.current = setTimeout(() => {
      if (!containerRef.current) return;
      const selected = collectSelection(containerRef.current, effectiveScale);
      if (!selected) return;
      // The backend rejects these; say so now instead of after the comment is written.
      if (
        selected.marks.length > MAX_MARKS ||
        new TextEncoder().encode(selected.quote).length > 20000
      ) {
        setNotice(t("pdf.selectionTooLargeToComment"));
        return;
      }
      setNotice(null);
      notes.beginDraft({ ...selected, pdf: pdfPath, style: mode, fingerprint, comment: "" });
    }, 0);
  };
  const captureRef = useRef(capture);
  captureRef.current = capture;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return attachPdfSelection(container, () => captureRef.current());
  }, []);
  const zoom = (amount: number) => {
    rememberAnchor();
    setManualScale(Math.max(0.1, Math.min(4, effectiveScale + amount)));
    setZoomMode("manual");
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-secondary px-2 py-1.5 text-xs">
        <span className="text-muted">
          {loadError
            ? t("pdf.pdfPreviewFailed")
            : numPages
              ? t("pdf.countCountPagePages", { count: numPages })
              : t("pdf.loadingPdf2")}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {notes && (
            <select
              aria-label={t("pdf.howToCommentOnThePdf")}
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
              className="border border-border bg-background px-2 py-1"
            >
              <option value="read">{t("pdf.readSelectText")}</option>
              <option value="highlight">{t("pdf.highlight")}</option>
              <option value="underline">{t("pdf.underline")}</option>
            </select>
          )}
          <button
            type="button"
            aria-pressed={zoomMode === "fit"}
            onClick={() => {
              rememberAnchor();
              setZoomMode("fit");
            }}
            className={`border px-2 py-1 ${zoomMode === "fit" ? "border-foreground bg-background" : "border-border text-muted"}`}
            title={t("pdf.adjustsToTheWindowScreenAndSidebarWidth")}
          >
            {t("pdf.fitWidth")}
          </button>
          <button
            type="button"
            aria-label={t("pdf.zoomOut")}
            onClick={() => zoom(-0.25)}
            className="px-2"
          >
            −
          </button>
          <button
            type="button"
            title={t("pdf.switchTo100ManualZoom")}
            onClick={() => {
              rememberAnchor();
              setManualScale(1);
              setZoomMode("manual");
            }}
          >
            {Math.round(effectiveScale * 100)}%
          </button>
          <button
            type="button"
            aria-label={t("pdf.zoomIn")}
            onClick={() => zoom(0.25)}
            className="px-2"
          >
            +
          </button>
        </div>
      </div>
      {notes && (
        <p className="shrink-0 border-b border-border px-2 py-1 text-[11px] text-muted">
          {t("pdf.dragOverTextToCommentManageThemUnderComm")}
        </p>
      )}
      {notice && (
        <p role="status" className="shrink-0 border-b border-border px-2 py-1 text-xs text-accent">
          {notice}
        </p>
      )}
      {staleCount > 0 && (
        <button
          type="button"
          onClick={() => notes?.setOpen(true)}
          className="shrink-0 border-b border-border px-2 py-1 text-left text-[11px] text-muted hover:text-foreground"
        >
          {t("pdf.countCommentsWereMadeOnAnEarlierBuild", { count: staleCount })}
        </button>
      )}
      {mappingInfo.warnings.length > 0 && (
        <p
          role="status"
          className="shrink-0 border-b border-border px-2 py-1 text-xs text-accent"
          title={mappingInfo.warnings.join("\n")}
        >
          {t("pdf.somePdfFontsLackAReliableTextMappingChec")}
        </p>
      )}
      {mappingInfo.repairedFonts.length > 0 && (
        <p
          className="shrink-0 border-b border-border px-2 py-1 text-[11px] text-muted"
          title={mappingInfo.repairedFonts.join("、")}
        >
          {t("pdf.restoredTheTextMappingOfCountCountFontFo", {
            count: mappingInfo.repairedFonts.length,
          })}
        </p>
      )}
      <section
        ref={containerRef}
        onKeyUp={capture}
        aria-label={t("pdf.pdfDocumentSelectTextToComment")}
        className="min-h-0 min-w-0 flex-1 overflow-auto bg-accent-hover p-4"
        style={{ overflowAnchor: "none" }}
      >
        {!previewSource ? (
          <p className="p-8 text-sm text-muted">{t("pdf.checkingThePdfTextMapping")}</p>
        ) : (
          <Document
            key={retry}
            file={previewSource}
            onLoadSuccess={async (pdf) => {
              setNumPages(pdf.numPages);
              setFingerprint(pdf.fingerprints[0] || "");
              setLoadError(null);
              try {
                const page = await pdf.getPage(1);
                setFirstWidth(page.getViewport({ scale: 1 }).width);
                const sizes = new Map<number, { width: number; height: number }>();
                for (let n = 1; n <= Math.min(pdf.numPages, 1000); n++) {
                  const size = (await pdf.getPage(n)).getViewport({ scale: 1 });
                  sizes.set(n, { width: size.width, height: size.height });
                }
                for (const [n, size] of sizes) pagesRef.current.set(n, size);
                setPageSizes(sizes);
              } catch {
                /* Each page still receives its own measured width. */
                setPageSizes(new Map());
              }
            }}
            onLoadError={(error) => {
              setLoadError(error.message);
              setNumPages(0);
            }}
            onSourceError={(error) => setLoadError(error.message)}
            loading={<p className="p-8 text-sm text-muted">{t("pdf.loadingPdf")}</p>}
            error={
              <div role="alert" className="space-y-3 p-8 text-sm">
                <p>{t("pdf.thePdfFailedToLoadError", { error: loadError ?? "" })}</p>
                <button
                  type="button"
                  onClick={() => {
                    setRetry((v) => v + 1);
                    setLoadError(null);
                  }}
                  className="border px-2 py-1"
                >
                  {t("pdf.retry")}
                </button>
              </div>
            }
          >
            {availableWidth > 0 && (
              <VirtualPdfPages
                numPages={numPages}
                availableWidth={availableWidth}
                zoomMode={zoomMode}
                manualScale={manualScale}
                effectiveScale={effectiveScale}
                pixelRatio={pixelRatio}
                annotations={annotations}
                fingerprint={fingerprint}
                selectedId={notes?.selectedId}
                highlight={highlight}
                containerRef={containerRef}
                pagesRef={pagesRef}
                sizes={pageSizes}
                onSynctexClick={onSynctexClick}
              />
            )}
          </Document>
        )}
      </section>
    </div>
  );
}

function VirtualPdfPages({
  numPages,
  availableWidth,
  zoomMode,
  manualScale,
  effectiveScale,
  pixelRatio,
  annotations,
  fingerprint,
  selectedId,
  highlight,
  containerRef,
  pagesRef,
  sizes,
  onSynctexClick,
}: {
  numPages: number;
  availableWidth: number;
  zoomMode: "fit" | "manual";
  manualScale: number;
  effectiveScale: number;
  pixelRatio: number;
  annotations: PdfAnnotation[];
  fingerprint: string;
  selectedId?: string | null;
  highlight?: PdfRegionBox | null;
  containerRef: React.RefObject<HTMLElement | null>;
  pagesRef: React.MutableRefObject<Map<number, { width: number; height: number }>>;
  sizes: Map<number, { width: number; height: number }> | null;
  onSynctexClick?: (page: number, x: number, y: number) => void;
}) {
  return (
    <>
      {Array.from({ length: numPages }, (_, index) => index + 1).map((page) => (
        <VirtualPdfPage
          key={page}
          page={page}
          availableWidth={availableWidth}
          zoomMode={zoomMode}
          manualScale={manualScale}
          effectiveScale={effectiveScale}
          pixelRatio={pixelRatio}
          annotations={annotations}
          fingerprint={fingerprint}
          selectedId={selectedId}
          highlight={highlight?.page === page ? highlight : null}
          containerRef={containerRef}
          pagesRef={pagesRef}
          size={sizes?.get(page)}
          onSynctexClick={onSynctexClick}
        />
      ))}
    </>
  );
}

function VirtualPdfPage({
  page,
  availableWidth,
  zoomMode,
  manualScale,
  effectiveScale,
  pixelRatio,
  annotations,
  fingerprint,
  selectedId,
  highlight,
  containerRef,
  pagesRef,
  size,
  onSynctexClick,
}: {
  page: number;
  availableWidth: number;
  zoomMode: "fit" | "manual";
  manualScale: number;
  effectiveScale: number;
  pixelRatio: number;
  annotations: PdfAnnotation[];
  fingerprint: string;
  selectedId?: string | null;
  highlight?: PdfRegionBox | null;
  containerRef: React.RefObject<HTMLElement | null>;
  pagesRef: React.MutableRefObject<Map<number, { width: number; height: number }>>;
  /** The page's size from the document, before the page itself has rendered. */
  size?: { width: number; height: number };
  onSynctexClick?: (page: number, x: number, y: number) => void;
}) {
  const { t } = useI18n();
  const pageRef = useRef<HTMLElement>(null);
  const [render, setRender] = useState(page <= 2);
  const [measured, setNatural] = useState(pagesRef.current.get(page));
  const natural = measured ?? size;
  useEffect(() => {
    const element = pageRef.current;
    const root = containerRef.current;
    if (!element || !root) return;
    let near = page <= 2;
    const update = () => {
      const selection = element.ownerDocument.getSelection();
      let selected = false;
      if (selection && !selection.isCollapsed && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        selected = root.contains(range.commonAncestorContainer) && range.intersectsNode(element);
      }
      setRender(near || selected);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        near = Boolean(entry?.isIntersecting);
        update();
      },
      { root, rootMargin: "1200px 0px" },
    );
    observer.observe(element);
    element.ownerDocument.addEventListener("selectionchange", update);
    return () => {
      observer.disconnect();
      element.ownerDocument.removeEventListener("selectionchange", update);
    };
  }, [containerRef, page]);
  const width = zoomMode === "fit" ? availableWidth : (natural?.width ?? 612) * manualScale;
  const height = natural ? width * (natural.height / natural.width) : width * Math.SQRT2;
  return (
    <section
      ref={pageRef}
      data-pdf-page={page}
      data-pdf-width={natural?.width}
      data-pdf-height={natural?.height}
      aria-label={t("pdf.pdfPagePage", { page })}
      onClick={(event) => {
        if (!onSynctexClick || (!event.metaKey && !event.ctrlKey)) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const scale = natural ? pageScale(rect.width, natural.width) : effectiveScale;
        onSynctexClick(
          page,
          (event.clientX - rect.left) / scale,
          (event.clientY - rect.top) / scale,
        );
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") window.getSelection()?.removeAllRanges();
      }}
      className="relative mx-auto mb-4 w-fit border-0 bg-white p-0 text-left select-text"
      style={{ minHeight: height, minWidth: width }}
    >
      {render && (
        <Page
          pageNumber={page}
          width={zoomMode === "fit" ? availableWidth : undefined}
          scale={zoomMode === "manual" ? manualScale : 1}
          devicePixelRatio={pixelRatio}
          renderTextLayer
          renderAnnotationLayer
          onLoadSuccess={(pdf) => {
            const size = pdf.getViewport({ scale: 1 });
            pagesRef.current.set(page, { width: size.width, height: size.height });
            setNatural({ width: size.width, height: size.height });
          }}
        />
      )}
      {highlight && natural && (
        <div
          className="pointer-events-none absolute z-[5] border-2 border-[#ff5500] bg-[#ff5500]/10"
          aria-hidden="true"
          style={{
            left: `${(highlight.x / natural.width) * 100}%`,
            top: `${(highlight.y / natural.height) * 100}%`,
            width: `${(Math.max(highlight.width, 4) / natural.width) * 100}%`,
            height: `${(Math.max(highlight.height, 4) / natural.height) * 100}%`,
          }}
        />
      )}
      <div className="pointer-events-none absolute inset-0 z-[4]" aria-hidden="true">
        {annotations
          ?.filter((note) => !note.resolved && note.fingerprint === fingerprint)
          .flatMap((note) =>
            visibleTextMarks(note.marks)
              .filter((mark) => mark.page === page)
              .map((mark) => (
                <span
                  key={`${note.id}-${mark.page}-${mark.x}-${mark.y}-${mark.width}`}
                  style={{
                    position: "absolute",
                    left: `${mark.x * 100}%`,
                    top: `${mark.y * 100}%`,
                    width: `${mark.width * 100}%`,
                    height: `${mark.height * 100}%`,
                    background: note.style === "highlight" ? "rgba(255,190,35,.30)" : undefined,
                    borderBottom: note.style === "underline" ? "2px solid #ff5500" : undefined,
                    outline: selectedId === note.id ? "1px solid #ff5500" : undefined,
                    mixBlendMode: "multiply",
                  }}
                />
              )),
          )}
      </div>
    </section>
  );
}
