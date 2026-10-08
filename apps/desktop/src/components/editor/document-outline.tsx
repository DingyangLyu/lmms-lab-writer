"use client";
import { CaretRightIcon, FileTextIcon, ListIcon } from "@phosphor-icons/react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { PanelHeightHandle, usePanelHeight } from "@/components/ui/panel-height";
import { useI18n } from "@/lib/i18n";
import { latexOutline, type OutlineEntry } from "@/lib/latex/outline";

export function DocumentOutline({
  path,
  source,
  error,
  onNavigate,
}: {
  path?: string;
  source: string;
  error?: string;
  onNavigate: (line: number) => void;
}) {
  const { t } = useI18n();
  const height = usePanelHeight("writer-outline-height", 0.35, 96);
  const deferredSource = useDeferredValue(source);
  const entries = useMemo(() => latexOutline(deferredSource), [deferredSource]);
  const [open, setOpen] = useState(true);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState("");
  useEffect(() => {
    setOpen(localStorage.getItem("writer-outline-open") !== "false");
  }, []);
  useEffect(() => {
    if (path) {
      setFolded(new Set());
      setSelected("");
    }
  }, [path]);
  const toggle = () =>
    setOpen((value) => {
      localStorage.setItem("writer-outline-open", String(!value));
      return !value;
    });
  const render = (nodes: OutlineEntry[], depth = 0) =>
    nodes.map((entry) => (
      <div key={entry.id}>
        <div
          className={`flex min-w-0 items-center hover:bg-accent-hover ${selected === entry.id ? "bg-accent-hover text-accent" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {entry.children.length ? (
            <button
              type="button"
              aria-label={t(folded.has(entry.id) ? "outline.unfoldTitle" : "outline.foldTitle", {
                title: entry.title,
              })}
              aria-expanded={!folded.has(entry.id)}
              onClick={() =>
                setFolded((current) => {
                  const next = new Set(current);
                  if (next.has(entry.id)) next.delete(entry.id);
                  else next.add(entry.id);
                  return next;
                })
              }
              className="shrink-0 p-1"
            >
              <CaretRightIcon
                className={`size-3 transition-transform ${folded.has(entry.id) ? "" : "rotate-90"}`}
              />
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <button
            type="button"
            title={`${entry.title}\n${path}:${entry.line}`}
            onClick={() => {
              setSelected(entry.id);
              const current =
                source === deferredSource ? entry : findEntry(latexOutline(source), entry.id);
              if (current) onNavigate(current.line);
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left text-xs"
          >
            {entry.kind === "include" && <FileTextIcon className="size-3 shrink-0 text-muted" />}
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted">{entry.line}</span>
          </button>
        </div>
        {!folded.has(entry.id) && render(entry.children, depth + 1)}
      </div>
    ));
  const allParentIds = (nodes: OutlineEntry[]): string[] =>
    nodes.flatMap((entry) =>
      entry.children.length ? [entry.id, ...allParentIds(entry.children)] : [],
    );
  return (
    <section
      ref={height.ref}
      aria-label={t("outline.documentOutline")}
      style={open ? height.style : undefined}
      className="flex min-h-0 shrink-0 flex-col border-t border-border"
    >
      {open && <PanelHeightHandle control={height} label={t("outline.dragToResizeTheOutline")} />}
      <div className="flex shrink-0 items-center border-b border-border">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left text-xs font-medium"
        >
          <CaretRightIcon className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
          <ListIcon className="size-3.5" />
          {t("outline.outline")}{" "}
          <span className="truncate font-normal text-muted">{path?.split("/").pop()}</span>
        </button>
        {open && (
          <button
            type="button"
            title={folded.size ? t("outline.unfoldAllSections") : t("outline.foldAllSections")}
            aria-label={folded.size ? t("outline.unfoldAllSections") : t("outline.foldAllSections")}
            onClick={() => setFolded(folded.size ? new Set() : new Set(allParentIds(entries)))}
            className="shrink-0 px-2 py-2 text-[10px] text-muted hover:text-accent"
          >
            {folded.size ? t("outline.unfold") : t("outline.fold")}
          </button>
        )}
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {error ? (
            <p role="alert" className="p-3 text-xs text-red-600">
              {error}
            </p>
          ) : entries.length ? (
            render(entries)
          ) : (
            <p className="p-3 text-xs text-muted">
              {path
                ? t("outline.thisDocumentHasNoSectionsOrFiguresYet")
                : t("outline.openATexDocumentToSeeItsSectionsAndFigur")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function findEntry(entries: OutlineEntry[], id: string): OutlineEntry | undefined {
  for (const entry of entries) {
    if (entry.id === id) return entry;
    const found = findEntry(entry.children, id);
    if (found) return found;
  }
  return undefined;
}
