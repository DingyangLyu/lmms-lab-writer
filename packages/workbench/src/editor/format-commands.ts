/**
 * Formatting from the editor toolbar and shortcuts, as plain text edits: they work the same
 * in code and visual mode, on the desktop and on the web (where Yjs carries them to others).
 */
import { startCompletion } from "@codemirror/autocomplete";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

const HEADING = /^(\s*)\\(section|subsection|subsubsection|paragraph|chapter)\*?\{(.*)\}(\s*)$/;
export type HeadingLevel = "section" | "subsection" | "subsubsection" | "paragraph";

/** The heading command on the cursor's line, or null for normal text. */
export function headingAt(state: EditorState): HeadingLevel | null {
  const line = state.doc.lineAt(state.selection.main.head);
  const level = HEADING.exec(line.text)?.[2];
  return level === "section" ||
    level === "subsection" ||
    level === "subsubsection" ||
    level === "paragraph"
    ? level
    : null;
}

/**
 * Wraps each selection in `before`…`after`; an empty one gets the pair with the cursor
 * between. A selection already wrapped exactly so is unwrapped instead.
 */
export function wrapSelection(view: EditorView, before: string, after: string) {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const outer =
        state.sliceDoc(range.from - before.length, range.from) === before &&
        state.sliceDoc(range.to, range.to + after.length) === after;
      if (outer && !range.empty)
        return {
          changes: [
            { from: range.from - before.length, to: range.from },
            { from: range.to, to: range.to + after.length },
          ],
          range: EditorSelection.range(range.from - before.length, range.to - before.length),
        };
      return {
        changes: [
          { from: range.from, insert: before },
          { from: range.to, insert: after },
        ],
        range: EditorSelection.range(range.from + before.length, range.to + before.length),
      };
    }),
  );
  view.focus();
  return true;
}

/** Makes the cursor's line a heading of `level`, or normal text when null. */
export function setHeading(view: EditorView, level: HeadingLevel | null) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const match = HEADING.exec(line.text);
  const content = match ? (match[3] ?? "") : line.text.trim();
  const indent = match ? (match[1] ?? "") : (/^\s*/.exec(line.text)?.[0] ?? "");
  const text = level ? `${indent}\\${level}{${content}}` : `${indent}${content}`;
  const cursor = line.from + indent.length + (level ? level.length + 2 : 0) + content.length;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: text },
    selection: EditorSelection.cursor(cursor),
  });
  view.focus();
  return true;
}

/** Turns the selected lines (or a new empty item) into an itemize or enumerate list. */
export function insertList(view: EditorView, kind: "itemize" | "enumerate") {
  const { state } = view;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from),
    last = state.doc.lineAt(range.to);
  const indent = /^\s*/.exec(first.text)?.[0] ?? "";
  const lines = range.empty
    ? [""]
    : state
        .sliceDoc(first.from, last.to)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
  const items = lines.map((l) => `${indent}  \\item ${l}`);
  const text = `${indent}\\begin{${kind}}\n${items.join("\n")}\n${indent}\\end{${kind}}`;
  const from = range.empty && first.text.trim() ? first.to : first.from;
  const insert = range.empty && first.text.trim() ? `\n${text}` : text;
  const cursor = from + insert.indexOf("\\item ") + "\\item ".length + (lines[0]?.length ?? 0);
  view.dispatch({
    changes: { from, to: range.empty ? from : last.to, insert },
    selection: EditorSelection.cursor(cursor),
  });
  view.focus();
  return true;
}

/**
 * Inserts `snippet` in place of the selection, or (with `block`) as lines of their own after
 * the cursor's line, indented like it; `|` marks where the cursor goes. With `complete`, the
 * completion list opens there (for citation keys and labels).
 */
export function insertSnippet(
  view: EditorView,
  snippet: string,
  { block = false, complete = false } = {},
) {
  const { state } = view;
  const range = state.selection.main;
  let from = range.from,
    to = range.to,
    text = snippet;
  if (block) {
    const line = state.doc.lineAt(range.from);
    const indent = /^\s*/.exec(line.text)?.[0] ?? "";
    text = snippet
      .split("\n")
      .map((l) => indent + l)
      .join("\n");
    if (line.text.trim()) {
      from = to = line.to;
      text = `\n${text}`;
    } else {
      from = line.from;
      to = line.to;
    }
  }
  const cursor = Math.max(0, text.indexOf("|"));
  text = text.replace("|", "");
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + cursor),
  });
  view.focus();
  if (complete) startCompletion(view);
  return true;
}

export const FIGURE_SNIPPET = String.raw`\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.8\linewidth]{|}
  \caption{}
  \label{fig:}
\end{figure}`;
export const TABLE_SNIPPET = String.raw`\begin{table}[htbp]
  \centering
  \caption{|}
  \label{tab:}
  \begin{tabular}{ll}
    \hline
    A & B \\
    \hline
    1 & 2 \\
    \hline
  \end{tabular}
\end{table}`;
export const DISPLAY_MATH_SNIPPET = String.raw`\begin{equation}
  |
  \label{eq:}
\end{equation}`;

/** ⌘B / Ctrl+B bold and ⌘I / Ctrl+I italic. */
export const formatKeymap = keymap.of([
  { key: "Mod-b", run: (view) => wrapSelection(view, "\\textbf{", "}") },
  { key: "Mod-i", run: (view) => wrapSelection(view, "\\textit{", "}") },
]);
