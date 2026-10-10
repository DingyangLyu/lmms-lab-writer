/**
 * Find and replace above the editor, after Overleaf's: the search with case, regular
 * expression and whole-word switches, which match of how many is selected, and replace one or
 * all. Enter finds the next match (Shift+Enter the previous one), Escape returns to the text.
 */
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { type WorkbenchKey, workbenchI18n } from "../i18n";

/** Counting stops here; a larger count shows as "9999+". */
const LIMIT = 9999;

/** How many matches there are, and which one (1-based) the selection is, if any. */
export function countMatches(state: EditorState, query: SearchQuery) {
  if (!query.search || !query.valid) return { total: 0, at: 0, more: false };
  const { from, to } = state.selection.main;
  let total = 0,
    at = 0;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    if (next.value.from === from && next.value.to === to) at = total;
    if (total >= LIMIT) return { total, at, more: !cursor.next().done };
  }
  return { total, at, more: false };
}

class WriterSearchPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private find: HTMLInputElement;
  private replace: HTMLInputElement;
  private toggles: Record<"caseSensitive" | "regexp" | "wholeWord", HTMLButtonElement>;
  private count: HTMLElement;
  private query: SearchQuery;

  constructor(private view: EditorView) {
    const t = (key: WorkbenchKey) => workbenchI18n.t(key);
    this.query = getSearchQuery(view.state);
    const element = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {},
      ...children: Array<Node | string>
    ) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(props))
        if (key.includes("-")) node.setAttribute(key, String(value));
        else (node as unknown as Record<string, unknown>)[key] = value;
      node.append(...children);
      return node;
    };
    const button = (label: string, title: string, run: () => void) =>
      element(
        "button",
        {
          type: "button",
          title,
          "aria-label": title,
          onmousedown: (event: MouseEvent) => event.preventDefault(),
          onclick: () => run(),
        },
        label,
      );
    this.find = element("input", {
      type: "text",
      value: this.query.search,
      placeholder: t("search.find"),
      "aria-label": t("search.find"),
      "main-field": "true",
      spellcheck: false,
      oninput: () => this.commit(),
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          (event.shiftKey ? findPrevious : findNext)(this.view);
        } else if (event.key === "Escape") this.close(event);
      },
    });
    this.replace = element("input", {
      type: "text",
      value: this.query.replace,
      placeholder: t("search.replaceWith"),
      "aria-label": t("search.replaceWith"),
      spellcheck: false,
      oninput: () => this.commit(),
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          (event.metaKey || event.ctrlKey ? replaceAll : replaceNext)(this.view);
        } else if (event.key === "Escape") this.close(event);
      },
    });
    const toggle = (label: string, title: string, on: boolean) => {
      const node = button(label, title, () => {
        node.setAttribute("aria-pressed", String(node.getAttribute("aria-pressed") !== "true"));
        this.commit();
        this.find.focus();
      });
      node.setAttribute("aria-pressed", String(on));
      node.classList.add("cm-writer-search-toggle");
      return node;
    };
    this.toggles = {
      caseSensitive: toggle("Aa", t("search.matchCase"), this.query.caseSensitive),
      regexp: toggle(".*", t("search.regexp"), this.query.regexp),
      wholeWord: toggle("W", t("search.wholeWord"), this.query.wholeWord),
    };
    this.count = element("span", { className: "cm-writer-search-count", "aria-live": "polite" });
    this.dom = element(
      "div",
      { className: "cm-writer-search", onkeydown: (event: KeyboardEvent) => this.keys(event) },
      element(
        "div",
        { className: "cm-writer-search-row" },
        this.find,
        this.toggles.caseSensitive,
        this.toggles.regexp,
        this.toggles.wholeWord,
        this.count,
        button("↑", t("search.previous"), () => findPrevious(this.view)),
        button("↓", t("search.next"), () => findNext(this.view)),
        button(t("search.all"), t("search.selectAll"), () => selectMatches(this.view)),
        button("×", t("search.close"), () => {
          closeSearchPanel(this.view);
          this.view.focus();
        }),
      ),
      element(
        "div",
        { className: "cm-writer-search-row" },
        this.replace,
        button(t("search.replace"), t("search.replaceTitle"), () => replaceNext(this.view)),
        button(t("search.replaceAll"), t("search.replaceAllTitle"), () => replaceAll(this.view)),
      ),
    );
    this.refresh();
  }
  private pressed(key: keyof WriterSearchPanel["toggles"]) {
    return this.toggles[key].getAttribute("aria-pressed") === "true";
  }
  private commit() {
    const query = new SearchQuery({
      search: this.find.value,
      replace: this.replace.value,
      caseSensitive: this.pressed("caseSensitive"),
      regexp: this.pressed("regexp"),
      wholeWord: this.pressed("wholeWord"),
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }
  /** Mod+F again selects the search text; the panel's own shortcuts work from either field. */
  private keys(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.find.select();
    } else if (mod && event.altKey && event.key === "Enter") {
      event.preventDefault();
      selectMatches(this.view);
    }
  }
  private close(event: KeyboardEvent) {
    event.preventDefault();
    closeSearchPanel(this.view);
    this.view.focus();
  }
  private refresh() {
    const invalid = !!this.query.search && !this.query.valid;
    this.find.setAttribute("aria-invalid", String(invalid));
    const { total, at, more } = countMatches(this.view.state, this.query);
    this.count.textContent = !this.query.search
      ? ""
      : invalid
        ? workbenchI18n.t("search.invalid")
        : !total
          ? workbenchI18n.t("search.none")
          : `${at || "–"} / ${total}${more ? "+" : ""}`;
  }
  update(update: ViewUpdate) {
    let changed = false;
    for (const transaction of update.transactions)
      for (const effect of transaction.effects)
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          this.find.value = effect.value.search;
          this.replace.value = effect.value.replace;
          this.toggles.caseSensitive.setAttribute(
            "aria-pressed",
            String(effect.value.caseSensitive),
          );
          this.toggles.regexp.setAttribute("aria-pressed", String(effect.value.regexp));
          this.toggles.wholeWord.setAttribute("aria-pressed", String(effect.value.wholeWord));
          changed = true;
        } else if (effect.is(setSearchQuery)) changed = true;
    if (changed || update.docChanged || update.selectionSet) this.refresh();
  }
  mount() {
    this.find.select();
  }
  get pos() {
    return 80;
  }
}

const theme = EditorView.baseTheme({
  ".cm-panels-top": { borderBottom: "1px solid var(--color-border, #e5e5e5)" },
  ".cm-writer-search": {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "6px 8px",
    fontFamily: "inherit",
    fontSize: "12px",
    background: "var(--color-background, #fff)",
    color: "var(--color-foreground, #111)",
  },
  ".cm-writer-search-row": { display: "flex", alignItems: "center", gap: "4px", minWidth: 0 },
  ".cm-writer-search input": {
    flex: "1 1 8rem",
    minWidth: "4rem",
    height: "26px",
    padding: "0 6px",
    border: "1px solid var(--color-border, #e5e5e5)",
    background: "var(--color-background, #fff)",
    color: "inherit",
    font: "inherit",
    outline: "none",
  },
  ".cm-writer-search input:focus": { borderColor: "var(--color-foreground, #111)" },
  ".cm-writer-search input[aria-invalid=true]": { borderColor: "#dc2626" },
  ".cm-writer-search button": {
    flex: "none",
    height: "26px",
    minWidth: "26px",
    padding: "0 6px",
    border: "1px solid var(--color-border, #e5e5e5)",
    background: "var(--color-background, #fff)",
    color: "inherit",
    font: "inherit",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  ".cm-writer-search button:hover": { background: "var(--color-accent-hover, #f5f5f5)" },
  ".cm-writer-search .cm-writer-search-toggle": { fontFamily: "ui-monospace, monospace" },
  ".cm-writer-search .cm-writer-search-toggle[aria-pressed=true]": {
    background: "var(--color-foreground, #111)",
    borderColor: "var(--color-foreground, #111)",
    color: "var(--color-background, #fff)",
  },
  ".cm-writer-search-count": {
    flex: "none",
    minWidth: "3.5rem",
    textAlign: "center",
    color: "var(--color-muted, #737373)",
    whiteSpace: "nowrap",
  },
});

/** Search with this panel; use with `searchKeymap` (Mod+F, F3, Mod+G, …). */
export function writerSearch(): Extension {
  return [search({ top: true, createPanel: (view) => new WriterSearchPanel(view) }), theme];
}
