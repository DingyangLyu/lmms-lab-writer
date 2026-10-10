/**
 * Spell checking in the editor, as Overleaf offers it: the browser's own checker (its red
 * underline and right-click suggestions), told to skip what is not prose — commands, math,
 * comments, citation and label keys, file names, options and verbatim text.
 */
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

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

const skip = Decoration.mark({ attributes: { spellcheck: "false" } });
/** How far around the visible text to look, so math or verbatim that starts above is seen. */
const MARGIN = 4000;

function decorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  let covered = 0;
  for (const visible of view.visibleRanges) {
    const from = Math.max(covered, doc.lineAt(Math.max(0, visible.from - MARGIN)).from);
    const to = doc.lineAt(Math.min(doc.length, visible.to + MARGIN)).to;
    if (to <= from) continue;
    for (const [a, b] of nonProse(doc.sliceString(from, to)))
      if (from + a >= covered) builder.add(from + a, from + b, skip);
    covered = to;
  }
  return builder.finish();
}

/**
 * The browser checks the prose in the languages its settings name; the decorations keep it away
 * from LaTeX. No `lang` is set: on a zh-CN page an English one would change how Chinese renders.
 */
export function latexSpellcheck(on: boolean) {
  if (!on) return EditorView.contentAttributes.of({ spellcheck: "false" });
  return [
    EditorView.contentAttributes.of({ spellcheck: "true" }),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = decorations(view);
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.viewportChanged)
            this.decorations = decorations(update.view);
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
  ];
}
