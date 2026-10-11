/**
 * Spell checking in the editor, as Overleaf offers it: English prose is checked against a
 * Hunspell dictionary the page brings along (so it works whatever the browser's own spelling
 * languages are), misspellings are underlined, and right-clicking one offers corrections, adding
 * the word to the member's dictionary, or ignoring it. Commands, math, comments, citation and
 * label keys, file names, options and verbatim text are not prose (nonProse below).
 */
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  showTooltip,
  type TooltipView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { i18n } from "./i18n";
import { addWord, ignoreWord, misspelled, onWordsChanged, suggestions } from "./spell/client";
import { proseWords, type Word } from "./spell/words";

/** Commands whose arguments are keys, names or code rather than prose. */
const KEYS = new Set([
  "cite",
  "citep",
  "citet",
  "citeauthor",
  "citeyear",
  "parencite",
  "textcite",
  "autocite",
  "nocite",
  "ref",
  "eqref",
  "autoref",
  "cref",
  "Cref",
  "pageref",
  "label",
  "usepackage",
  "RequirePackage",
  "documentclass",
  "input",
  "include",
  "subfile",
  "includegraphics",
  "bibliography",
  "bibliographystyle",
  "addbibresource",
  "url",
  "href",
  "begin",
  "end",
  "newcommand",
  "renewcommand",
  "providecommand",
  "newenvironment",
  "renewenvironment",
  "DeclareMathOperator",
  "setlength",
  "setcounter",
  "color",
  "textcolor",
  "definecolor",
  "graphicspath",
  "hypersetup",
  "lstinputlisting",
  "inputminted",
]);
const MATH_ENVIRONMENTS =
  "equation|align|gather|multline|eqnarray|displaymath|math|flalign|alignat|split|tikzpicture|verbatim|lstlisting|minted|comment";

/** Offsets [from, to) in `text` the checker should skip, sorted and not overlapping. */
export function nonProse(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const add = (from: number, to: number) => {
    if (to > from) ranges.push([from, to]);
  };
  const scan = (pattern: RegExp) => {
    for (const found of text.matchAll(pattern)) add(found.index, found.index + found[0].length);
  };
  scan(new RegExp(`\\\\begin\\{(${MATH_ENVIRONMENTS})(\\*?)\\}[\\s\\S]*?\\\\end\\{\\1\\2\\}`, "g"));
  scan(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$\\\n])+\$/g);
  scan(/(?<!\\)%.*$/gm);
  scan(/\\verb(.).*?\1/g);
  // Commands, any options after them, and the arguments of the ones that take keys.
  const command = /\\([A-Za-z@]+)\*?|\\./g;
  for (let found = command.exec(text); found; found = command.exec(text)) {
    let end = command.lastIndex;
    const name = found[1];
    if (name) {
      for (;;) {
        let at = end;
        while (text[at] === " ") at++;
        const open = text[at];
        if (open === "[") {
          const close = text.indexOf("]", at);
          if (close < 0) break;
          end = close + 1;
        } else if (open === "{" && KEYS.has(name)) {
          const close = text.indexOf("}", at);
          if (close < 0) break;
          end = close + 1;
        } else break;
      }
    }
    add(found.index, end);
    command.lastIndex = end;
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

const wrong = Decoration.mark({ class: "cm-misspelled" });
/** How far around the visible text to look, so math or verbatim that starts above is seen. */
const MARGIN = 4000;

/** The prose words of the visible text (and a margin around it), at their places. */
function visibleWords(view: EditorView): Word[] {
  const doc = view.state.doc;
  const words: Word[] = [];
  let covered = 0;
  for (const visible of view.visibleRanges) {
    const from = Math.max(covered, doc.lineAt(Math.max(0, visible.from - MARGIN)).from);
    const to = doc.lineAt(Math.min(doc.length, visible.to + MARGIN)).to;
    if (to <= from) continue;
    for (const w of proseWords(doc.sliceString(from, to)))
      words.push({ from: from + w.from, to: from + w.to, word: w.word });
    covered = to;
  }
  return words;
}

const marked = StateEffect.define<DecorationSet>();
const spellPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    timer: ReturnType<typeof setTimeout> | null = null;
    round = 0;
    stop: () => void;
    constructor(readonly view: EditorView) {
      this.schedule(0);
      this.stop = onWordsChanged(() => this.schedule(0));
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = this.decorations.map(update.changes);
      for (const tr of update.transactions)
        for (const effect of tr.effects) if (effect.is(marked)) this.decorations = effect.value;
      if (update.docChanged || update.viewportChanged) this.schedule(400);
    }
    schedule(delay: number) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.check(), delay);
    }
    async check() {
      const round = ++this.round,
        doc = this.view.state.doc;
      const words = visibleWords(this.view);
      let bad: Set<string>;
      try {
        bad = await misspelled(words.map((w) => w.word));
      } catch {
        return; // The dictionary did not load; the text simply stays unmarked.
      }
      if (round !== this.round) return;
      // Typed meanwhile: the places moved, so look again.
      if (this.view.state.doc !== doc) return this.schedule(200);
      const builder = new RangeSetBuilder<Decoration>();
      for (const w of words) if (bad.has(w.word)) builder.add(w.from, w.to, wrong);
      this.view.dispatch({ effects: marked.of(builder.finish()) });
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
      this.round++;
      this.stop();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The right-click menu of a misspelled word. */
type Menu = { from: number; to: number; word: string };
const showMenu = StateEffect.define<Menu | null>();
const menuField = StateField.define<Menu | null>({
  create: () => null,
  update(menu, tr) {
    for (const effect of tr.effects) if (effect.is(showMenu)) return effect.value;
    return tr.docChanged ? null : menu;
  },
  provide: (field) =>
    showTooltip.from(field, (menu) =>
      menu
        ? { pos: menu.from, end: menu.to, above: false, create: (view) => menuView(view, menu) }
        : null,
    ),
});

function menuView(view: EditorView, menu: Menu): TooltipView {
  const close = () => view.dispatch({ effects: showMenu.of(null) });
  const dom = document.createElement("div");
  dom.className = "cm-spell-menu";
  const button = (label: string, run: () => void, className = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (className) b.className = className;
    b.addEventListener("mousedown", (event) => event.preventDefault());
    b.addEventListener("click", run);
    return b;
  };
  const list = dom.appendChild(document.createElement("div"));
  list.className = "cm-spell-list";
  list.textContent = i18n.t("spell.loading");
  void suggestions(menu.word)
    .then((found) => {
      list.textContent = "";
      if (!found.length) list.textContent = i18n.t("spell.none");
      for (const suggestion of found)
        list.appendChild(
          button(
            suggestion,
            () => {
              view.dispatch({
                changes: { from: menu.from, to: menu.to, insert: suggestion },
                effects: showMenu.of(null),
              });
              view.focus();
            },
            "cm-spell-suggestion",
          ),
        );
    })
    .catch(() => {
      list.textContent = i18n.t("spell.none");
    });
  dom.appendChild(document.createElement("hr"));
  dom.appendChild(
    button(i18n.t("spell.add", { word: menu.word }), () => {
      addWord(menu.word);
      close();
    }),
  );
  dom.appendChild(
    button(i18n.t("spell.ignore"), () => {
      ignoreWord(menu.word);
      close();
    }),
  );
  return { dom };
}

/**
 * Our own checker on the prose of the file, and the browser's off (it would underline every
 * command, and only in the languages its settings name).
 */
export function latexSpellcheck(on: boolean) {
  if (!on) return EditorView.contentAttributes.of({ spellcheck: "false" });
  return [
    EditorView.contentAttributes.of({ spellcheck: "false" }),
    spellPlugin,
    menuField,
    EditorView.domEventHandlers({
      contextmenu(event, view) {
        const target = (event.target as HTMLElement | null)?.closest?.(".cm-misspelled");
        if (!target) return false;
        const at = view.posAtDOM(target);
        let found: { from: number; to: number } | null = null;
        view.plugin(spellPlugin)?.decorations.between(at, at + 1, (from, to) => {
          found = { from, to };
          return false;
        });
        if (!found) return false;
        const { from, to } = found;
        event.preventDefault();
        view.dispatch({
          effects: showMenu.of({
            from,
            to,
            word: view.state.sliceDoc(from, to).replace(/’/g, "'"),
          }),
        });
        return true;
      },
      mousedown(event, view) {
        if (
          view.state.field(menuField) &&
          !(event.target as HTMLElement | null)?.closest?.(".cm-spell-menu")
        )
          view.dispatch({ effects: showMenu.of(null) });
        return false;
      },
    }),
    keymap.of([
      {
        key: "Escape",
        run: (view) => {
          if (!view.state.field(menuField)) return false;
          view.dispatch({ effects: showMenu.of(null) });
          return true;
        },
      },
    ]),
    EditorView.baseTheme({
      ".cm-misspelled": {
        textDecoration: "underline wavy #dc2626",
        textDecorationSkipInk: "none",
        textUnderlineOffset: "3px",
      },
      ".cm-tooltip:has(.cm-spell-menu)": { padding: "0" },
      ".cm-spell-menu": {
        display: "flex",
        flexDirection: "column",
        minWidth: "160px",
        padding: "4px 0",
        fontFamily: "system-ui, sans-serif",
        fontSize: "12px",
      },
      ".cm-spell-list": { display: "flex", flexDirection: "column", padding: "0 0 2px" },
      ".cm-spell-menu button": {
        padding: "4px 12px",
        border: "0",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
      },
      ".cm-spell-menu button:hover": { background: "rgb(0 0 0 / 0.06)" },
      ".cm-spell-menu .cm-spell-suggestion": { fontWeight: "600" },
      ".cm-spell-list:not(:has(button))": { padding: "4px 12px", opacity: "0.6" },
      ".cm-spell-menu hr": {
        margin: "2px 0",
        border: "0",
        borderTop: "1px solid rgb(0 0 0 / 0.1)",
      },
    }),
  ];
}
