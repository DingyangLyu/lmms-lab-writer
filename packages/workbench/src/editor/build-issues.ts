/**
 * The last build's errors and warnings in the editor: a marker beside each line (hover for the
 * message and what usually causes it) and a tint on error lines. Also the plain-language hints
 * for common TeX messages that the build logs show.
 */
import { RangeSet, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from "@codemirror/view";
import { workbenchI18n as i18n } from "../i18n";

export type EditorIssue = { line: number; level: "error" | "warning"; message: string };

/** What usually causes a TeX error or warning, in the interface language; null if not known. */
export function texErrorHint(message: string): string | null {
  // In order: a missing package reads better than "file not found".
  const rules: [RegExp, Parameters<typeof i18n.t>[0]][] = [
    [/\.sty' not found|LaTeX Error: File `[^']*\.(sty|cls)'/i, "build.hintPackage"],
    [/Undefined control sequence/i, "build.hintUndefinedControl"],
    [/Missing \$ inserted/i, "build.hintMissingDollar"],
    [
      /File [`']?[^']*'? not found|cannot find image file|Unable to load picture/i,
      "build.hintFileNotFound",
    ],
    [/Citation .* undefined|There were undefined citations/i, "build.hintCitation"],
    [/Reference .* undefined|There were undefined references/i, "build.hintReference"],
    [/Extra \}, or forgotten|Too many \}'s|Missing \} inserted/i, "build.hintBraces"],
    [/Runaway argument|File ended while scanning|Paragraph ended before/i, "build.hintRunaway"],
    [/Missing \\begin\{document\}/i, "build.hintBeginDocument"],
    [/Environment .* undefined/i, "build.hintEnvironment"],
    [/\\begin\{.*\} on input line \d+ ended by \\end|ended by \\end\{/i, "build.hintBeginEnd"],
    [/Overfull \\hbox/i, "build.hintOverfull"],
    [/Underfull \\hbox/i, "build.hintUnderfull"],
    [/Unicode character|inputenc Error|Invalid UTF-8/i, "build.hintUnicode"],
    [/fontspec.*(not found|cannot be found)|Font .* not found/i, "build.hintFont"],
    [/Misplaced alignment tab character/i, "build.hintAmpersand"],
    [/perhaps a missing \\item/i, "build.hintItem"],
    [/Double (superscript|subscript)/i, "build.hintDoubleScript"],
    [/LaTeX Error: Option clash/i, "build.hintOptionClash"],
  ];
  for (const [pattern, key] of rules) if (pattern.test(message)) return i18n.t(key);
  return null;
}

export const setEditorIssues = StateEffect.define<EditorIssue[]>();
const issueField = StateField.define<EditorIssue[]>({
  create: () => [],
  update(issues, tr) {
    for (const effect of tr.effects) if (effect.is(setEditorIssues)) return effect.value;
    // Edits move lines; the markers stay on the line numbers of the build until the next one.
    return issues;
  },
});

class IssueMarker extends GutterMarker {
  constructor(
    readonly level: "error" | "warning",
    readonly text: string,
  ) {
    super();
  }
  eq(other: IssueMarker) {
    return other.level === this.level && other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = `cm-issue-marker cm-issue-${this.level}`;
    span.textContent = this.level === "error" ? "●" : "▲";
    span.title = this.text;
    return span;
  }
}

function markers(state: EditorView["state"]) {
  const issues = state.field(issueField);
  const byLine = new Map<number, EditorIssue[]>();
  for (const issue of issues)
    if (issue.line >= 1 && issue.line <= state.doc.lines)
      byLine.set(issue.line, [...(byLine.get(issue.line) ?? []), issue]);
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const list = byLine.get(line) ?? [];
    const level = list.some((i) => i.level === "error") ? "error" : "warning";
    const text = list
      .map((i) => {
        const hint = texErrorHint(i.message);
        return hint ? `${i.message}\n${hint}` : i.message;
      })
      .join("\n\n");
    builder.add(state.doc.line(line).from, state.doc.line(line).from, new IssueMarker(level, text));
  }
  return builder.finish();
}
const issueLines = EditorView.decorations.compute([issueField, "doc"], (state): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  const lines = [
    ...new Set(
      state
        .field(issueField)
        .filter((i) => i.level === "error")
        .map((i) => i.line),
    ),
  ]
    .filter((line) => line >= 1 && line <= state.doc.lines)
    .sort((a, b) => a - b);
  for (const line of lines)
    builder.add(
      state.doc.line(line).from,
      state.doc.line(line).from,
      Decoration.line({ class: "cm-issue-line" }),
    );
  return builder.finish();
});

/** The issue gutter and line tints; set them with `setEditorIssues`. */
export function editorIssues() {
  return [
    issueField,
    issueLines,
    gutter({
      class: "cm-issue-gutter",
      markers: (view) =>
        view.state.field(issueField).length ? markers(view.state) : RangeSet.empty,
    }),
    EditorView.baseTheme({
      ".cm-issue-gutter": { width: "14px" },
      ".cm-issue-marker": { cursor: "help", fontSize: "10px", lineHeight: "inherit" },
      ".cm-issue-error": { color: "#dc2626" },
      ".cm-issue-warning": { color: "#d97706" },
      ".cm-issue-line": { backgroundColor: "#fee2e266" },
      "&dark .cm-issue-line": { backgroundColor: "#7f1d1d40" },
    }),
  ];
}
