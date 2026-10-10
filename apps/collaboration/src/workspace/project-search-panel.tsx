/**
 * Search the whole project from the sidebar, as Overleaf does: every text file, the editor's
 * switches (case, regular expression, whole word), results by file with their lines, and
 * replace in one file or all of them (a version is saved first, so History can undo it).
 */

import { useWorkbenchI18n } from "@lmms-lab/workbench";
import { ArrowsClockwiseIcon, CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SourceFile } from "../../shared/api";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { findMatches, replaceAll, type SearchOptions, searchPattern } from "./project-search";
import { Btn, Input } from "./ui";

const LIMIT = 2000;

export function ProjectSearchPanel({
  ws,
  refresh,
  onOpen,
}: {
  ws: WorkspaceContext;
  /** Reads every text file again from the server. */
  refresh: () => Promise<SourceFile[]>;
  onOpen: (path: string, line: number) => void;
}) {
  const { t } = useI18n();
  // The editor's own search words, shared with the desktop.
  const { t: wt } = useWorkbenchI18n();
  const [options, setOptions] = useState<SearchOptions>({
    query: "",
    caseSensitive: false,
    regexp: false,
    wholeWord: false,
  });
  const [replacement, setReplacement] = useState(""),
    [replacing, setReplacing] = useState(false),
    [sources, setSources] = useState<SourceFile[]>([]),
    [closed, setClosed] = useState<Set<string>>(new Set()),
    [message, setMessage] = useState("");
  const load = useCallback(
    () =>
      refresh()
        .then(setSources)
        .catch((error) => ws.report(errorText(error))),
    [refresh, ws.report],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const pattern = useMemo(() => searchPattern(options), [options]);
  // The open file as it is in the editor; the rest as the server has them.
  const openPath = ws.file && !ws.file.binary ? ws.file.path : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor's text is read when the search or the files change.
  const results = useMemo(() => {
    if (!(pattern instanceof RegExp)) return [];
    let left = LIMIT;
    const list = [];
    for (const f of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
      if (left <= 0) break;
      const text = f.path === openPath ? (ws.editor.current?.text() ?? f.content) : f.content;
      const matches = findMatches(text, pattern, left);
      if (!matches.length) continue;
      left -= matches.length;
      list.push({ file: f, matches });
    }
    return list;
  }, [pattern, sources, openPath]);
  const total = results.reduce((n, r) => n + r.matches.length, 0);
  const toggle = (key: "caseSensitive" | "regexp" | "wholeWord", label: string, title: string) => (
    <button
      type="button"
      aria-pressed={options[key]}
      title={title}
      aria-label={title}
      onClick={() => setOptions((o) => ({ ...o, [key]: !o[key] }))}
      className={`h-7 min-w-7 border px-1.5 font-mono text-[11px] ${options[key] ? "border-foreground bg-foreground text-background" : "border-border hover:bg-accent-hover"}`}
    >
      {label}
    </button>
  );
  /** Replaces in the files given (all when none), after saving a version. */
  const replace = (only?: string) =>
    ws.run(async () => {
      if (!(pattern instanceof RegExp)) return;
      const fresh = await refresh();
      const plans = fresh
        .filter((f) => !only || f.id === only)
        .map((f) => ({ file: f, ...replaceAll(f.content, pattern, replacement, options.regexp) }))
        .filter((p) => p.count > 0);
      const count = plans.reduce((n, p) => n + p.count, 0);
      if (!count) {
        setMessage(t("psearch.nothing"));
        return;
      }
      if (!confirm(t("psearch.confirm", { count, files: plans.length }))) return;
      await api(`${ws.prefix}/snapshots`, { label: t("psearch.snapshot") });
      const failed: string[] = [];
      for (const plan of plans)
        try {
          await api(
            `${ws.prefix}/files/${plan.file.id}`,
            { expected: plan.file.content, content: plan.content },
            "PUT",
          );
        } catch {
          failed.push(plan.file.path);
        }
      await ws.reload();
      await load();
      setMessage(
        failed.length
          ? t("psearch.partly", { count, failed: failed.join(", ") })
          : t("psearch.done", { count, files: plans.length }),
      );
    });
  return (
    <section aria-label={t("psearch.title")} className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="shrink-0 space-y-1.5 border-b border-border p-2">
        <div className="flex items-center gap-1">
          <Input
            type="search"
            autoFocus
            value={options.query}
            placeholder={t("psearch.placeholder")}
            aria-label={t("psearch.placeholder")}
            aria-invalid={pattern instanceof Error}
            onChange={(e) => {
              setMessage("");
              setOptions((o) => ({ ...o, query: e.target.value }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
            className={`min-w-0 flex-1 ${pattern instanceof Error ? "border-red-500" : ""}`}
          />
          <button
            type="button"
            title={t("psearch.refresh")}
            aria-label={t("psearch.refresh")}
            onClick={() => void load()}
            className="flex h-7 w-7 shrink-0 items-center justify-center border border-border hover:bg-accent-hover"
          >
            <ArrowsClockwiseIcon className="size-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          {toggle("caseSensitive", "Aa", wt("search.matchCase"))}
          {toggle("regexp", ".*", wt("search.regexp"))}
          {toggle("wholeWord", "W", wt("search.wholeWord"))}
          {ws.canEdit && (
            <button
              type="button"
              aria-expanded={replacing}
              onClick={() => setReplacing((v) => !v)}
              className="ml-auto border border-border px-2 py-1 hover:bg-accent-hover"
            >
              {wt("search.replace")}
            </button>
          )}
        </div>
        {replacing && ws.canEdit && (
          <div className="flex items-center gap-1">
            <Input
              value={replacement}
              placeholder={wt("search.replaceWith")}
              aria-label={wt("search.replaceWith")}
              onChange={(e) => setReplacement(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Btn
              tone="solid"
              disabled={ws.busy || !total}
              title={t("psearch.replaceAllTitle")}
              onClick={() => replace()}
            >
              {wt("search.replaceAll")}
            </Btn>
          </div>
        )}
        <p role="status" className="text-[11px] text-muted">
          {pattern instanceof Error
            ? wt("search.invalid")
            : message ||
              (options.query
                ? total
                  ? t("psearch.count", { count: total, files: results.length }) +
                    (total >= LIMIT ? ` ${t("psearch.limited", { limit: LIMIT })}` : "")
                  : wt("search.none")
                : t("psearch.hint"))}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.map(({ file, matches }) => {
          const folded = closed.has(file.id);
          return (
            <div key={file.id} className="border-b border-border">
              <div className="flex items-center gap-1 bg-accent-hover/60 px-2 py-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1 text-left font-medium"
                  aria-expanded={!folded}
                  onClick={() =>
                    setClosed((set) => {
                      const next = new Set(set);
                      if (folded) next.delete(file.id);
                      else next.add(file.id);
                      return next;
                    })
                  }
                >
                  {folded ? (
                    <CaretRightIcon className="size-3 shrink-0" />
                  ) : (
                    <CaretDownIcon className="size-3 shrink-0" />
                  )}
                  <span className="truncate">{file.path}</span>
                  <span className="shrink-0 text-muted">{matches.length}</span>
                </button>
                {replacing && ws.canEdit && (
                  <button
                    type="button"
                    disabled={ws.busy}
                    className="shrink-0 text-[11px] text-muted hover:text-foreground disabled:opacity-40"
                    onClick={() => replace(file.id)}
                  >
                    {t("psearch.replaceFile")}
                  </button>
                )}
              </div>
              {!folded &&
                matches.map((m) => (
                  <button
                    key={m.from}
                    type="button"
                    onClick={() => onOpen(file.path, m.line)}
                    className="flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-accent-hover"
                  >
                    <span className="w-8 shrink-0 text-right tabular-nums text-muted">
                      {m.line}
                    </span>
                    <span className="min-w-0 truncate font-mono text-[11px]">
                      {m.preview.slice(0, m.at)}
                      <mark className="bg-amber-200 text-foreground">
                        {m.preview.slice(m.at, m.at + m.length)}
                      </mark>
                      {m.preview.slice(m.at + m.length)}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
