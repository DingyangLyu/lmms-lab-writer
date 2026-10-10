/**
 * The symbol palette, after Overleaf's: search by name or look through the categories, and a
 * click writes the symbol's command at the cursor. The host places it (a pop-over under the
 * editor's toolbar on the web).
 */
import { useState } from "react";
import { useWorkbenchI18n } from "../i18n";
import { findSymbols, type SymbolCategory } from "./symbols";

const CATEGORIES: Array<SymbolCategory | "all"> = [
  "all",
  "greek",
  "arrows",
  "operators",
  "relations",
  "misc",
];

export function SymbolPalette({ onInsert }: { onInsert: (command: string) => void }) {
  const { t } = useWorkbenchI18n();
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState<SymbolCategory | "all">("all");
  const shown = findSymbols(query, category === "all" ? undefined : category);
  return (
    <div className="flex min-h-0 flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-2">
        <input
          type="search"
          value={query}
          // biome-ignore lint/a11y/noAutofocus: the palette opens to search it.
          autoFocus
          placeholder={t("symbols.search")}
          aria-label={t("symbols.search")}
          onChange={(event) => setQuery(event.target.value)}
          className="h-7 min-w-0 flex-1 border border-border bg-background px-2 focus:border-foreground focus:outline-none"
        />
      </div>
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
            className={`shrink-0 whitespace-nowrap border px-2 py-0.5 ${category === c ? "border-foreground bg-foreground text-background" : "border-border hover:bg-accent-hover"}`}
          >
            {t(`symbols.${c}`)}
          </button>
        ))}
      </div>
      <div className="grid min-h-0 grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] gap-1 overflow-y-auto p-2">
        {shown.map((s) => (
          <button
            key={`${s.category}:${s.command}`}
            type="button"
            title={`${s.command}${s.package ? ` · ${t("symbols.needs", { package: s.package })}` : ""}${s.text ? "" : ` · ${t("symbols.math")}`}`}
            aria-label={s.command}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onInsert(s.command)}
            className="flex h-10 items-center justify-center border border-border text-lg hover:border-foreground hover:bg-accent-hover"
          >
            {s.glyph}
          </button>
        ))}
        {!shown.length && (
          <p className="col-span-full py-4 text-center text-muted">{t("symbols.none")}</p>
        )}
      </div>
      <p className="shrink-0 border-t border-border px-2 py-1.5 text-[11px] text-muted">
        {t("symbols.hint")}
      </p>
    </div>
  );
}
