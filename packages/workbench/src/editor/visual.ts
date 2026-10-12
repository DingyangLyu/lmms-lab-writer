/**
 * Visual mode for the LaTeX editor: the same text, shown closer to the page. Headings, bold
 * and italic, lists, citations and references, math (rendered with KaTeX), figures and the
 * title read as they will print; the preamble folds away. Wherever the cursor or selection
 * is, that construct shows its LaTeX again, so everything stays editable as source and
 * collaboration, comments and tracked changes work exactly as in code mode.
 *
 * A plain scanner (not a full TeX parser) finds the constructs; anything it does not know
 * stays as source.
 */
import {
  EditorSelection,
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";
import { workbenchI18n as i18n } from "../i18n";

export type VisualOptions = {
  /** A URL for an image the project has (\includegraphics), or null to show its name. */
  resolveImage?: (path: string) => string | null;
};

type Kind = "block" | "inline";
/** Something drawn differently, with the span that shows its source while selected. */
type Construct = { from: number; to: number; kind: Kind; decorations: Range<Decoration>[] };
const isReplace = (d: Range<Decoration>) =>
  d.from < d.to && !d.value.spec.class && !d.value.spec.attributes;

const HEADINGS: Record<string, number> = {
  part: 1,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 5,
};
const STYLES: Record<string, string> = {
  textbf: "cm-v-bold",
  textit: "cm-v-italic",
  emph: "cm-v-italic",
  textsl: "cm-v-italic",
  underline: "cm-v-underline",
  texttt: "cm-v-mono",
  textsc: "cm-v-smallcaps",
  textsf: "cm-v-sans",
  footnote: "cm-v-footnote",
  caption: "cm-v-caption",
  url: "cm-v-link",
};
const MATH_ENVS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "eqnarray",
  "eqnarray*",
  "displaymath",
  "math",
]);
const LISTS = new Set(["itemize", "enumerate", "description"]);
const HIDDEN_LINES = new Set(["figure", "figure*", "table", "table*", "center", "document"]);

/** The index just past the group opened at `open` (a "{" or "["), or -1 if unclosed. */
export function closing(text: string, open: number, limit = text.length): number {
  const opener = text[open],
    closer = opener === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "%") {
      const end = text.indexOf("\n", i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === opener) depth++;
    else if (c === closer && --depth === 0) return i + 1;
  }
  return -1;
}
/** Comment spans (from an unescaped % to the line's end), so constructs inside are skipped. */
function comments(text: string) {
  const spans: [number, number][] = [];
  const re = /(^|[^\\])(\\\\)*%/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].length - 1;
    const end = text.indexOf("\n", start);
    spans.push([start, end < 0 ? text.length : end]);
    re.lastIndex = end < 0 ? text.length : end;
  }
  return spans;
}
/** The first argument's braces after a command ending at `at`, skipping [options] and spaces. */
function argument(text: string, at: number) {
  let i = at;
  while (true) {
    while (text[i] === " " || text[i] === "\t") i++;
    if (text[i] === "[") {
      const end = closing(text, i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    break;
  }
  if (text[i] !== "{") return null;
  const end = closing(text, i);
  return end < 0 ? null : { open: i, close: end - 1 };
}
const hide = (from: number, to: number) => Decoration.replace({}).range(from, to);

class TextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly className: string,
    readonly title = "",
  ) {
    super();
  }
  eq(other: TextWidget) {
    return other.text === this.text && other.className === this.className;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    if (this.title) span.title = this.title;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}
class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
    readonly labels: string[] = [],
  ) {
    super();
  }
  eq(other: MathWidget) {
    return (
      other.source === this.source &&
      other.display === this.display &&
      other.labels.join() === this.labels.join()
    );
  }
  toDOM() {
    const box = document.createElement(this.display ? "div" : "span");
    box.className = this.display ? "cm-v-math-display" : "cm-v-math";
    try {
      katex.render(this.source, box, {
        displayMode: this.display,
        throwOnError: false,
        strict: "ignore",
        trust: false,
      });
    } catch {
      box.textContent = this.source;
    }
    for (const label of this.labels) {
      const tag = document.createElement("span");
      tag.className = "cm-v-chip cm-v-label";
      tag.textContent = label;
      box.append(tag);
    }
    return box;
  }
  ignoreEvent() {
    return false;
  }
}
class ImageWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly url: string | null,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.path === this.path && other.url === this.url;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-v-figure";
    if (this.url && !/\.pdf$/i.test(this.path)) {
      const img = document.createElement("img");
      img.src = this.url;
      img.alt = this.path;
      img.onerror = () => img.replaceWith(document.createTextNode(`🖼 ${this.path}`));
      box.append(img);
    } else box.textContent = `🖼 ${this.path}`;
    return box;
  }
  ignoreEvent() {
    return false;
  }
}
class TitleWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly author: string,
    readonly date: string,
  ) {
    super();
  }
  eq(other: TitleWidget) {
    return other.title === this.title && other.author === this.author && other.date === this.date;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-v-title";
    for (const [text, cls] of [
      [this.title, "cm-v-title-main"],
      [this.author, "cm-v-title-meta"],
      [this.date, "cm-v-title-meta"],
    ] as const)
      if (text) {
        const line = document.createElement("div");
        line.className = cls;
        line.textContent = plain(text);
        box.append(line);
      }
    if (!box.childElementCount) box.textContent = "\\maketitle";
    return box;
  }
  ignoreEvent() {
    return false;
  }
}
class PreambleWidget extends WidgetType {
  constructor(readonly shown: boolean) {
    super();
  }
  eq(other: PreambleWidget) {
    return other.shown === this.shown;
  }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-v-preamble";
    button.textContent = this.shown
      ? i18n.t("editor.visualHidePreamble")
      : i18n.t("editor.visualShowPreamble");
    button.onmousedown = (event) => {
      event.preventDefault();
      view.dispatch({ effects: togglePreamble.of(!this.shown) });
    };
    return button;
  }
  ignoreEvent() {
    return true;
  }
}
/** Text of a short LaTeX argument without its commands, for the title block. */
function plain(text: string) {
  return text
    .replace(/\\\\(\[[^\]]*\])?/g, " · ")
    .replace(/\\and\b/g, " · ")
    .replace(/\\(thanks|footnote)\{[^}]*\}/g, "")
    .replace(/\\today\b/g, new Date().toLocaleDateString())
    .replace(/\\[a-zA-Z@]+\*?/g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function preambleArgument(text: string, name: string, end: number) {
  const m = new RegExp(`\\\\${name}\\s*(\\[[^\\]]*\\])?\\s*\\{`).exec(text.slice(0, end));
  if (!m) return "";
  const open = m.index + m[0].length - 1;
  const close = closing(text, open, end);
  return close < 0 ? "" : text.slice(open + 1, close - 1);
}

/** Every construct in the document, in order of position. */
export function scanVisual(
  state: EditorState,
  options: VisualOptions,
  showPreamble: boolean,
): Construct[] {
  const text = state.doc.toString();
  const found: Construct[] = [];
  const commented = comments(text);
  const inComment = (at: number) => {
    // Binary search: the comment spans are sorted.
    let lo = 0,
      hi = commented.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [a, b] = commented[mid] as [number, number];
      if (at < a) hi = mid - 1;
      else if (at >= b) lo = mid + 1;
      else return true;
    }
    return false;
  };
  const line = (at: number) => state.doc.lineAt(at);
  const begin = /\\begin\{document\}/g.exec(text);
  const body = begin && !inComment(begin.index) ? line(begin.index).to : 0;

  // The preamble folds into one line; shown, it keeps a line to fold it again.
  if (body) {
    found.push({
      from: 0,
      to: body,
      kind: "block",
      decorations: showPreamble
        ? [Decoration.widget({ widget: new PreambleWidget(true), block: true, side: -1 }).range(0)]
        : [Decoration.replace({ widget: new PreambleWidget(false), block: true }).range(0, body)],
    });
  }
  const scanFrom = showPreamble ? 0 : body;

  // \maketitle: the title, authors and date from the preamble.
  for (const m of text.matchAll(/\\maketitle\b/g)) {
    if (m.index < scanFrom || inComment(m.index)) continue;
    const l = line(m.index);
    if (text.slice(l.from, l.to).trim() !== "\\maketitle") continue;
    const end = body || m.index;
    found.push({
      from: l.from,
      to: l.to,
      kind: "block",
      decorations: [
        Decoration.replace({
          widget: new TitleWidget(
            preambleArgument(text, "title", end),
            preambleArgument(text, "author", end),
            preambleArgument(text, "date", end),
          ),
          block: true,
        }).range(l.from, l.to),
      ],
    });
  }

  // Display math: environments, \[ \] and $$ $$.
  const displays: [number, number][] = [];
  for (const m of text.matchAll(/\\begin\{([a-zA-Z]+\*?)\}/g)) {
    const env = m[1] as string;
    if (m.index < scanFrom || inComment(m.index) || !MATH_ENVS.has(env)) continue;
    const endTag = `\\end{${env}}`;
    const end = text.indexOf(endTag, m.index);
    if (end < 0) continue;
    const to = end + endTag.length;
    const inner = text.slice(m.index + m[0].length, end);
    const labels = [...inner.matchAll(/\\label\{([^}]*)\}/g)].map((x) => x[1] as string);
    let source = inner.replace(/\\label\{[^}]*\}/g, "").replace(/\\(nonumber|notag)\b/g, "");
    const base = env.replace("*", "");
    if (base === "align" || base === "eqnarray") source = `\\begin{aligned}${source}\\end{aligned}`;
    if (base === "gather") source = `\\begin{gathered}${source}\\end{gathered}`;
    const from = line(m.index).from,
      lineEnd = line(to).to;
    // Only whole lines become a block; anything else beside it on the line stays source.
    if (text.slice(from, m.index).trim() || text.slice(to, lineEnd).trim()) continue;
    displays.push([from, lineEnd]);
    found.push({
      from,
      to: lineEnd,
      kind: "block",
      decorations: [
        Decoration.replace({ widget: new MathWidget(source, true, labels), block: true }).range(
          from,
          lineEnd,
        ),
      ],
    });
  }
  const inDisplay = (at: number) => displays.some(([a, b]) => at >= a && at < b);
  for (const m of text.matchAll(/\\\[([\s\S]*?)\\\]|\$\$([\s\S]+?)\$\$/g)) {
    if (m.index < scanFrom || inComment(m.index) || inDisplay(m.index)) continue;
    const to = m.index + m[0].length;
    const from = line(m.index).from,
      lineEnd = line(to).to;
    const whole = !text.slice(from, m.index).trim() && !text.slice(to, lineEnd).trim();
    displays.push([m.index, to]);
    found.push(
      whole
        ? {
            from,
            to: lineEnd,
            kind: "block",
            decorations: [
              Decoration.replace({
                widget: new MathWidget(m[1] ?? m[2] ?? "", true),
                block: true,
              }).range(from, lineEnd),
            ],
          }
        : {
            from: m.index,
            to,
            kind: "inline",
            decorations: [
              Decoration.replace({ widget: new MathWidget(m[1] ?? m[2] ?? "", false) }).range(
                m.index,
                to,
              ),
            ],
          },
    );
  }

  // Inline math: $…$ and \( … \).
  const maths: [number, number][] = [];
  for (let i = scanFrom; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      if (text[i + 1] === "(") {
        const end = text.indexOf("\\)", i + 2);
        if (end > 0 && !inComment(i) && !inDisplay(i)) {
          maths.push([i, end + 2]);
          found.push({
            from: i,
            to: end + 2,
            kind: "inline",
            decorations: [
              Decoration.replace({ widget: new MathWidget(text.slice(i + 2, end), false) }).range(
                i,
                end + 2,
              ),
            ],
          });
          i = end + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === "%") {
      const end = text.indexOf("\n", i);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (c !== "$" || inDisplay(i)) continue;
    if (text[i + 1] === "$") {
      i++;
      continue;
    }
    let j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === "$" || (text[j] === "\n" && text[j + 1] === "\n")) break;
    }
    if (text[j] !== "$" || j === i + 1) continue;
    maths.push([i, j + 1]);
    found.push({
      from: i,
      to: j + 1,
      kind: "inline",
      decorations: [
        Decoration.replace({ widget: new MathWidget(text.slice(i + 1, j), false) }).range(i, j + 1),
      ],
    });
    i = j;
  }
  const inMath = (at: number) => inDisplay(at) || maths.some(([a, b]) => at >= a && at < b);

  // Commands.
  let listDepth = 0;
  const enumerators: number[] = [];
  for (const m of text.matchAll(/\\([a-zA-Z]+)(\*?)/g)) {
    const at = m.index,
      name = m[1] as string,
      after = at + m[0].length;
    if (at < scanFrom || inComment(at) || inMath(at)) continue;
    const l = line(at);
    const level = HEADINGS[name];
    if (level) {
      const arg = argument(text, after);
      if (!arg) continue;
      found.push({
        from: at,
        to: arg.close + 1,
        kind: "inline",
        decorations: [
          Decoration.line({ class: `cm-v-heading cm-v-h${level}` }).range(l.from),
          hide(at, arg.open + 1),
          hide(arg.close, arg.close + 1),
        ],
      });
      continue;
    }
    const style = STYLES[name];
    if (style) {
      const arg = argument(text, after);
      if (!arg) continue;
      const decorations = [hide(at, arg.open + 1), hide(arg.close, arg.close + 1)];
      if (arg.close > arg.open + 1)
        decorations.push(Decoration.mark({ class: style }).range(arg.open + 1, arg.close));
      found.push({ from: at, to: arg.close + 1, kind: "inline", decorations });
      continue;
    }
    if (name === "href") {
      const url = argument(text, after);
      const label = url && argument(text, url.close + 1);
      if (!url || !label) continue;
      const decorations = [hide(at, label.open + 1), hide(label.close, label.close + 1)];
      if (label.close > label.open + 1)
        decorations.push(
          Decoration.mark({ class: "cm-v-link" }).range(label.open + 1, label.close),
        );
      found.push({ from: at, to: label.close + 1, kind: "inline", decorations });
      continue;
    }
    if (/^(cite[a-zA-Z]*|[pP]arencite|[tT]extcite|[aA]utocite|footcite|nocite)$/.test(name)) {
      const arg = argument(text, after);
      if (!arg) continue;
      const keys = text.slice(arg.open + 1, arg.close).replace(/\s+/g, "");
      found.push({
        from: at,
        to: arg.close + 1,
        kind: "inline",
        decorations: [
          Decoration.replace({
            widget: new TextWidget(keys.split(",").join(", "), "cm-v-chip cm-v-cite", `\\${name}`),
          }).range(at, arg.close + 1),
        ],
      });
      continue;
    }
    if (/^(ref|eqref|autoref|cref|Cref|pageref|nameref|label)$/.test(name)) {
      const arg = argument(text, after);
      if (!arg) continue;
      found.push({
        from: at,
        to: arg.close + 1,
        kind: "inline",
        decorations: [
          Decoration.replace({
            widget: new TextWidget(
              text.slice(arg.open + 1, arg.close).trim(),
              `cm-v-chip ${name === "label" ? "cm-v-label" : "cm-v-ref"}`,
              `\\${name}`,
            ),
          }).range(at, arg.close + 1),
        ],
      });
      continue;
    }
    if (name === "includegraphics") {
      const arg = argument(text, after);
      if (!arg) continue;
      const path = text.slice(arg.open + 1, arg.close).trim();
      const whole = !text.slice(l.from, at).trim() && !text.slice(arg.close + 1, l.to).trim();
      const widget = new ImageWidget(path, options.resolveImage?.(path) ?? null);
      found.push({
        from: whole ? l.from : at,
        to: whole ? l.to : arg.close + 1,
        kind: whole ? "block" : "inline",
        decorations: [
          (whole
            ? Decoration.replace({ widget, block: true })
            : Decoration.replace({ widget })
          ).range(whole ? l.from : at, whole ? l.to : arg.close + 1),
        ],
      });
      continue;
    }
    if (name === "begin" || name === "end") {
      const arg = argument(text, after);
      if (!arg) continue;
      const env = text.slice(arg.open + 1, arg.close);
      const whole = !text.slice(l.from, at).trim();
      if (LISTS.has(env)) {
        if (name === "begin") {
          listDepth++;
          enumerators.push(env === "enumerate" ? 0 : -1);
        } else {
          listDepth = Math.max(0, listDepth - 1);
          enumerators.pop();
        }
      }
      if (env === "document" && name === "end" && whole) {
        found.push({
          from: l.from,
          to: l.to,
          kind: "block",
          decorations: [
            Decoration.replace({
              widget: new TextWidget(i18n.t("editor.visualEndOfDocument"), "cm-v-end"),
              block: true,
            }).range(l.from, l.to),
          ],
        });
        continue;
      }
      if (env === "abstract" && whole) {
        found.push({
          from: l.from,
          to: l.to,
          kind: "block",
          decorations:
            name === "begin"
              ? [
                  Decoration.replace({
                    widget: new TextWidget(i18n.t("editor.visualAbstract"), "cm-v-abstract"),
                    block: true,
                  }).range(l.from, l.to),
                ]
              : [Decoration.replace({ block: true }).range(l.from, l.to)],
        });
        continue;
      }
      // The lines that only open or close a list, figure or table go out of sight.
      const rest = text
        .slice(arg.close + 1, l.to)
        .replace(/^\s*\[[^\]]*\]/, "")
        .trim();
      if (whole && !rest && (LISTS.has(env) || HIDDEN_LINES.has(env)) && l.to > l.from)
        found.push({
          from: l.from,
          to: l.to,
          kind: "block",
          decorations: [Decoration.replace({ block: true }).range(l.from, l.to)],
        });
      continue;
    }
    if (name === "item" && listDepth > 0) {
      const top = enumerators.length - 1;
      const numbered = (enumerators[top] ?? -1) >= 0;
      if (numbered) enumerators[top] = (enumerators[top] ?? 0) + 1;
      let end = after;
      if (text[end] === "[") {
        const close = closing(text, end);
        if (close > 0) end = close;
      }
      const mark = numbered ? `${enumerators[top]}.` : listDepth % 2 ? "•" : "◦";
      found.push({
        from: at,
        to: end,
        kind: "inline",
        decorations: [
          Decoration.line({
            class: "cm-v-item",
            // A hanging indent: wrapped lines line up with the item's text, not its bullet.
            attributes: {
              style: `padding-left: calc(24px + ${listDepth * 1.25 + 1.4}em); text-indent: -1.4em`,
            },
          }).range(l.from),
          Decoration.replace({ widget: new TextWidget(mark, "cm-v-bullet") }).range(at, end),
        ],
      });
      continue;
    }
    if (name === "centering" && !text.slice(l.from, at).trim() && !text.slice(after, l.to).trim()) {
      found.push({
        from: l.from,
        to: l.to,
        kind: "block",
        decorations: [Decoration.replace({ block: true }).range(l.from, l.to)],
      });
    }
    // \% \& \_ \# \$ and \{ \} read as the character.
  }
  for (const m of text.matchAll(/(?<!\\)~/g)) {
    if (m.index < scanFrom || inComment(m.index) || inMath(m.index)) continue;
    found.push({
      from: m.index,
      to: m.index + 1,
      kind: "inline",
      decorations: [
        Decoration.replace({ widget: new TextWidget("\u00a0", "") }).range(m.index, m.index + 1),
      ],
    });
  }
  for (const m of text.matchAll(/\\([%&_#${}])/g)) {
    if (m.index < scanFrom || inComment(m.index) || inDisplay(m.index)) continue;
    found.push({
      from: m.index,
      to: m.index + 2,
      kind: "inline",
      decorations: [hide(m.index, m.index + 1)],
    });
  }
  return found.sort((a, b) => a.from - b.from || b.to - a.to);
}

/** The decorations, leaving as source whatever the selection touches. */
function decorate(state: EditorState, constructs: Construct[]): DecorationSet {
  const ranges = state.selection.ranges;
  const shown: Range<Decoration>[] = [];
  // Replaced spans kept so far that may still enclose what follows (constructs come by start).
  let open: [number, number][] = [];
  for (const c of constructs) {
    if (ranges.some((r) => r.from <= c.to && r.to >= c.from)) continue;
    open = open.filter(([, b]) => b > c.from);
    const replaces = c.decorations.filter(isReplace);
    // Replacements may not overlap: an inner one inside a replaced span stays hidden with it.
    if (replaces.some((d) => open.some(([a, b]) => a < d.to && b > d.from))) continue;
    for (const d of replaces) open.push([d.from, d.to]);
    shown.push(...c.decorations);
  }
  return Decoration.set(shown, true);
}

const togglePreamble = StateEffect.define<boolean>();
type VisualState = { constructs: Construct[]; preamble: boolean; decorations: DecorationSet };

function visualField(options: VisualOptions) {
  return StateField.define<VisualState>({
    create(state) {
      const constructs = scanVisual(state, options, false);
      return { constructs, preamble: false, decorations: decorate(state, constructs) };
    },
    update(value, tr) {
      let { constructs, preamble } = value;
      let rescan = tr.docChanged;
      for (const effect of tr.effects)
        if (effect.is(togglePreamble)) {
          preamble = effect.value;
          rescan = true;
        }
      if (rescan) constructs = scanVisual(tr.state, options, preamble);
      if (!rescan && !tr.selection) return value;
      return { constructs, preamble, decorations: decorate(tr.state, constructs) };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}

const visualTheme = EditorView.baseTheme({
  "&.cm-visual .cm-content": {
    fontFamily: '"Iowan Old Style", Georgia, "Noto Serif", "Songti SC", "Noto Serif CJK SC", serif',
    lineHeight: "1.7",
  },
  "&.cm-visual .cm-line": { padding: "0 24px" },
  ".cm-v-heading": { fontWeight: "700", lineHeight: "1.4" },
  ".cm-v-h1": { fontSize: "1.6em", paddingTop: "0.6em !important" },
  ".cm-v-h2": { fontSize: "1.4em", paddingTop: "0.5em !important" },
  ".cm-v-h3": { fontSize: "1.2em", paddingTop: "0.4em !important" },
  ".cm-v-h4": { fontSize: "1.08em" },
  ".cm-v-h5": { fontSize: "1em", fontStyle: "italic" },
  ".cm-v-bold": { fontWeight: "700" },
  ".cm-v-italic": { fontStyle: "italic" },
  ".cm-v-underline": { textDecoration: "underline" },
  ".cm-v-mono": { fontFamily: "ui-monospace, monospace", fontSize: "0.92em" },
  ".cm-v-smallcaps": { fontVariant: "small-caps" },
  ".cm-v-sans": { fontFamily: "system-ui, sans-serif" },
  ".cm-v-footnote": { fontSize: "0.85em", opacity: "0.75", verticalAlign: "super" },
  ".cm-v-caption": { fontSize: "0.92em", fontStyle: "italic" },
  ".cm-v-link": { color: "#2563eb", textDecoration: "underline" },
  ".cm-v-chip": {
    display: "inline-block",
    border: "1px solid #c7ced6",
    backgroundColor: "#f3f5f7",
    color: "#374151",
    fontFamily: "system-ui, sans-serif",
    fontSize: "0.82em",
    lineHeight: "1.4",
    padding: "0 5px",
    margin: "0 1px",
    verticalAlign: "baseline",
    cursor: "text",
  },
  ".cm-v-cite::before": { content: '"📖 "' },
  ".cm-v-ref::before": { content: '"🔗 "' },
  ".cm-v-label": { color: "#6b7280", backgroundColor: "transparent" },
  ".cm-v-label::before": { content: '"🏷 "' },
  ".cm-v-bullet": { display: "inline-block", minWidth: "1.4em", fontWeight: "600" },
  ".cm-v-math-display": { textAlign: "center", padding: "6px 0", overflowX: "auto" },
  ".cm-v-math-display .cm-v-label": { marginLeft: "12px", verticalAlign: "middle" },
  ".cm-v-figure": {
    textAlign: "center",
    padding: "6px 0",
    color: "#6b7280",
    fontFamily: "system-ui, sans-serif",
  },
  ".cm-v-figure img": {
    display: "inline-block",
    maxWidth: "70%",
    maxHeight: "320px",
    objectFit: "contain",
  },
  ".cm-v-title": { textAlign: "center", padding: "12px 0" },
  ".cm-v-title-main": { fontSize: "1.7em", fontWeight: "600", lineHeight: "1.3" },
  ".cm-v-title-meta": { fontSize: "1.05em", marginTop: "4px" },
  ".cm-v-abstract": { display: "block", textAlign: "center", fontWeight: "700", padding: "6px 0" },
  ".cm-v-end": {
    display: "block",
    textAlign: "center",
    fontFamily: "system-ui, sans-serif",
    fontSize: "0.85em",
    color: "#6b7280",
    borderTop: "1px solid #e5e7eb",
    marginTop: "8px",
    padding: "6px 0",
  },
  ".cm-v-preamble": {
    display: "block",
    width: "100%",
    textAlign: "left",
    fontFamily: "system-ui, sans-serif",
    fontSize: "0.85em",
    color: "#4b5563",
    background: "#f3f4f6",
    border: "1px solid #e5e7eb",
    padding: "4px 10px",
    margin: "4px 0",
    cursor: "pointer",
  },
  "&dark .cm-v-chip": { backgroundColor: "#2d333b", borderColor: "#444c56", color: "#c9d1d9" },
  "&dark .cm-v-preamble": { backgroundColor: "#2d333b", borderColor: "#444c56", color: "#c9d1d9" },
  "&dark .cm-v-link": { color: "#79b8ff" },
});

/** Moves the cursor into a construct shown visually when its widget is clicked. */
export const revealOnClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement;
    if (!target.closest(".cm-v-math, .cm-v-math-display, .cm-v-chip, .cm-v-figure, .cm-v-title"))
      return false;
    const pos = view.posAtDOM(target);
    view.dispatch({ selection: EditorSelection.cursor(pos) });
    view.focus();
    event.preventDefault();
    return true;
  },
});

/** Visual mode on, or nothing; put it in a Compartment to switch. */
export function visualMode(on: boolean, options: VisualOptions = {}): Extension {
  if (!on) return [];
  return [
    visualField(options),
    visualTheme,
    revealOnClick,
    EditorView.editorAttributes.of({ class: "cm-visual" }),
  ];
}
