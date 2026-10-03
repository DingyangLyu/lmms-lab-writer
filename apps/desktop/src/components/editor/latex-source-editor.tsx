"use client";

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleLineComment,
} from "@codemirror/commands";
import {
  bracketMatching,
  codeFolding,
  foldCode,
  foldEffect,
  foldedRanges,
  foldGutter,
  foldKeymap,
  indentUnit,
  unfoldAll,
  unfoldCode,
  unfoldEffect,
} from "@codemirror/language";
import { gotoLine, highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers,
  MatchDecorator,
  rectangularSelection,
  ViewPlugin,
} from "@codemirror/view";
import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { trackEditorDrag } from "@/lib/codemirror/drag-selection";
import { latexFolding, latexFoldRanges } from "@/lib/codemirror/latex-folding";
import { latexHighlighting, latexLanguage } from "@/lib/codemirror/latex-language";
import { resolveMonoFontFamily } from "@/lib/editor/font-stacks";
import { documentEdits } from "@/lib/editor/merge";
import type { EditorTextRange } from "@/lib/editor/selection-context";
import type { SourceMark } from "@/lib/editor/source-annotations";
import type { EditorSettings, EditorTheme } from "@/lib/editor/types";

export type LatexSourceEditorProps = {
  annotationMarks?: SourceMark[];
  annotationContent?: string;
  onAnnotationClick?: (id: string) => void;
  onAnnotate?: (ranges: EditorTextRange[], content: string) => void;
  content?: string;
  readOnly?: boolean;
  className?: string;
  editorSettings?: Partial<EditorSettings>;
  editorTheme?: EditorTheme;
  onContentChange?: (content: string, previous?: string) => void;
  goToLine?: number;
  onSelectionChange?: (ranges: EditorTextRange[] | null) => void;
};

const setAnnotationMarks = StateEffect.define<DecorationSet>();
const annotationDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (marks, tr) => {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) if (effect.is(setAnnotationMarks)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const commands = [
  "begin",
  "end",
  "section",
  "subsection",
  "subsubsection",
  "chapter",
  "cite",
  "ref",
  "label",
  "caption",
  "includegraphics",
  "textbf",
  "textit",
  "emph",
  "footnote",
  "item",
  "frac",
  "sqrt",
  "usepackage",
  "documentclass",
];
const ambiguousMatcher = new MatchDecorator({
  regexp: /[，。；：（）［］｛｝！＂＇]/g,
  decoration: Decoration.mark({ class: "cm-ambiguous-punctuation" }),
});
const ambiguousPunctuation = ViewPlugin.define(
  (view) => ({
    decorations: ambiguousMatcher.createDeco(view),
    update(update) {
      this.decorations = ambiguousMatcher.updateDeco(update, this.decorations);
    },
  }),
  { decorations: (value) => value.decorations },
);

function appearance(settings: Partial<EditorSettings>, dark: boolean): Extension {
  const foreground = dark ? "#c9d1d9" : "#24292e";
  const background = dark ? "#24292e" : "#ffffff";
  return [
    latexHighlighting(dark),
    EditorView.theme(
      {
        "&": {
          height: "100%",
          fontSize: `${settings.fontSize ?? 14}px`,
          backgroundColor: background,
          color: foreground,
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: resolveMonoFontFamily(settings.fontFamily),
          lineHeight: String(settings.lineHeight ?? 1.6),
        },
        ".cm-content": { padding: "16px 0", caretColor: foreground, fontVariantLigatures: "none" },
        ".cm-line": { padding: "0 8px" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: foreground, borderLeftWidth: "2px" },
        ".cm-gutters": {
          backgroundColor: background,
          color: dark ? "#8b949e" : "#737373",
          border: "none",
          paddingRight: "4px",
        },
        ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", padding: "0 7px" },
        ".cm-foldGutter .cm-gutterElement": { width: "18px", padding: "0 2px", cursor: "pointer" },
        // drawSelection paints below the text. An opaque line background hides
        // an entire selection when both endpoints are in the same logical line.
        ".cm-activeLine": { backgroundColor: dark ? "#ffffff08" : "#00000006" },
        ".cm-activeLineGutter": { backgroundColor: dark ? "#2b3137" : "#f5f5f5" },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
          {
            backgroundColor: dark ? "#3d5270" : "#b5d5ff",
          },
        ".cm-selectionMatch": { backgroundColor: dark ? "#3b404880" : "#dce8f880" },
        ".cm-matchingBracket": {
          backgroundColor: dark ? "#3b4048" : "#e0e7f0",
          outline: "1px solid #8999a8",
        },
        ".cm-foldPlaceholder": {
          border: "1px solid #a4b3a8",
          borderRadius: "0",
          backgroundColor: dark ? "#303d34" : "#edf4ee",
          color: dark ? "#bdd2be" : "#45644e",
          padding: "0 5px",
          margin: "0 3px",
          cursor: "pointer",
        },
        ".cm-ambiguous-punctuation": { outline: "1px solid #ce7a2c" },
        ".cm-tooltip": {
          backgroundColor: background,
          color: foreground,
          border: "1px solid #89939e",
          borderRadius: "0",
        },
        ".cm-panels": { backgroundColor: background, color: foreground },
        "&.cm-focused": { outline: "none" },
      },
      { dark },
    ),
  ];
}

function configurable(
  settings: Partial<EditorSettings>,
  dark: boolean,
  readOnly: boolean,
): Extension {
  const lineNumberMode = settings.lineNumbers ?? "on";
  return [
    appearance(settings, dark),
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorState.tabSize.of(settings.tabSize ?? 2),
    indentUnit.of(settings.insertSpaces === false ? "\t" : " ".repeat(settings.tabSize ?? 2)),
    settings.wordWrap === "off" ? [] : EditorView.lineWrapping,
    settings.highlightAmbiguousUnicode ? ambiguousPunctuation : [],
    settings.renderWhitespace === "all"
      ? highlightWhitespace()
      : settings.renderWhitespace === "trailing"
        ? highlightTrailingWhitespace()
        : [],
    settings.autoClosingBrackets === "never" ? [] : closeBrackets(),
    lineNumberMode === "off"
      ? []
      : lineNumbers({
          formatNumber: (number, state) =>
            lineNumberMode === "relative"
              ? String(
                  Math.abs(number - state.doc.lineAt(state.selection.main.head).number) || number,
                )
              : lineNumberMode === "interval" && number % 10 !== 0 && number !== 1
                ? ""
                : String(number),
        }),
  ];
}

/** Native contenteditable input keeps IME pre-edit text in its wrapped LaTeX line. */
export const LatexSourceEditor = memo(function LatexSourceEditor(props: LatexSourceEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialProps = useRef(props);
  const currentProps = useRef(props);
  const config = useRef(new Compartment());
  const externalUpdate = useRef(false);
  const selectionEmitted = useRef(false);
  const syncRef = useRef<(content?: string) => void>(() => {});
  useLayoutEffect(() => {
    currentProps.current = props;
  });

  useEffect(() => {
    if (!container.current) return;
    const initial = initialProps.current;
    let compositionTimer: ReturnType<typeof setTimeout> | undefined;
    let drag: ReturnType<typeof trackEditorDrag> | undefined;
    const reportSelection = (view: EditorView) => {
      if (currentProps.current.readOnly) return;
      const ranges = view.state.selection.ranges
        .filter((range) => !range.empty)
        .map((range) => {
          const start = view.state.doc.lineAt(range.from);
          const end = view.state.doc.lineAt(range.to);
          return {
            startLineNumber: start.number,
            startColumn: range.from - start.from + 1,
            endLineNumber: end.number,
            endColumn: range.to - end.from + 1,
            startOffset: range.from + (start.number - 1) * (view.state.lineBreak.length - 1),
            endOffset: range.to + (end.number - 1) * (view.state.lineBreak.length - 1),
            text: view.state.sliceDoc(range.from, range.to),
          };
        });
      if (ranges.length || selectionEmitted.current) {
        selectionEmitted.current = ranges.length > 0;
        currentProps.current.onSelectionChange?.(ranges.length ? ranges : null);
      }
    };
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: initial.content ?? "",
        extensions: [
          EditorState.lineSeparator.of(initial.content?.includes("\r\n") ? "\r\n" : "\n"),
          latexLanguage,
          annotationDecorations,
          latexFolding,
          codeFolding({ placeholderText: " … 展开 " }),
          foldGutter({
            markerDOM: (expanded) => {
              const marker = document.createElement("span");
              marker.textContent = expanded ? "⌄" : "›";
              marker.title = expanded ? "折叠此注释、章节或环境" : "展开内容";
              marker.setAttribute("aria-label", marker.title);
              return marker;
            },
          }),
          history(),
          drawSelection(),
          rectangularSelection(),
          bracketMatching(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          highlightSpecialChars(),
          autocompletion({
            override: [
              (context) => {
                const word = context.matchBefore(/\\[a-zA-Z]*/);
                return word
                  ? {
                      from: word.from + 1,
                      options: commands.map((label) => ({ label, type: "keyword" })),
                    }
                  : null;
              },
            ],
          }),
          keymap.of([
            { key: "Mod-/", run: toggleLineComment },
            { key: "Ctrl-g", run: gotoLine },
            ...foldKeymap,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          config.current.of(
            configurable(
              initial.editorSettings ?? {},
              initial.editorTheme === "one-dark",
              initial.readOnly ?? false,
            ),
          ),
          EditorView.contentAttributes.of({
            "aria-label": "LaTeX 文稿编辑器",
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
          }),
          EditorView.domEventHandlers({
            click: (event) => {
              if (!(event.metaKey || event.ctrlKey)) return false;
              const id = (event.target as HTMLElement)
                .closest("[data-writer-annotation]")
                ?.getAttribute("data-writer-annotation");
              if (id) {
                currentProps.current.onAnnotationClick?.(id);
                return true;
              }
              return false;
            },
            compositionend: () => {
              // WebKit commits the final text after compositionend. Wait for that transaction.
              compositionTimer = setTimeout(() => syncRef.current(), 0);
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !externalUpdate.current)
              currentProps.current.onContentChange?.(
                update.state.sliceDoc(),
                update.startState.sliceDoc(),
              );
            if (update.docChanged && selectionEmitted.current) {
              selectionEmitted.current = false;
              currentProps.current.onSelectionChange?.(null);
            }
            if (update.selectionSet && update.view.hasFocus && !currentProps.current.readOnly) {
              if (!drag?.state.active) reportSelection(update.view);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    drag = trackEditorDrag(view.contentDOM, () => reportSelection(view));
    view.focus();
    return () => {
      if (compositionTimer) clearTimeout(compositionTimer);
      drag?.dispose();
      view.destroy();
      viewRef.current = null;
      if (selectionEmitted.current) currentProps.current.onSelectionChange?.(null);
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: config.current.reconfigure(
        configurable(
          props.editorSettings ?? {},
          props.editorTheme === "one-dark",
          props.readOnly ?? false,
        ),
      ),
    });
  }, [props.editorSettings, props.editorTheme, props.readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const content = props.content || "";
    if (props.annotationContent !== content) return;
    if (view.state.doc.toString() !== content.replace(/\r\n/g, "\n")) return;
    const position = (offset: number) => content.slice(0, offset).replace(/\r\n/g, "\n").length;
    const ranges = (props.annotationMarks || []).flatMap((note) =>
      note.ranges
        .filter((r) => r.end > r.start && r.state !== "deleted")
        .map((r) => {
          const from = position(r.start),
            to = Math.min(view.state.doc.length, position(r.end));
          return from < to
            ? Decoration.mark({
                class: `writer-note-${note.style} ${note.resolved ? "writer-note-resolved" : ""}`,
                attributes: {
                  "data-writer-annotation": note.id,
                  title: `${note.resolved ? "已解决 · " : ""}${note.comment} · ⌘/Ctrl+点击查看`,
                },
              }).range(from, to)
            : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null),
    );
    view.dispatch({ effects: setAnnotationMarks.of(Decoration.set(ranges, true)) });
  }, [props.annotationMarks, props.annotationContent, props.content]);

  syncRef.current = (content) => {
    const view = viewRef.current;
    const incoming = (content ?? currentProps.current.content ?? "").replace(/\r\n/g, "\n");
    if (!view || view.composing) return;
    const current = view.state.doc.toString();
    if (current === incoming) return;
    // Incremental disjoint changes preserve folds and selection between edits.
    externalUpdate.current = true;
    try {
      view.dispatch({
        changes: documentEdits(current, incoming),
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      externalUpdate.current = false;
    }
  };
  useEffect(() => {
    syncRef.current(props.content ?? "");
  }, [props.content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !props.goToLine || props.goToLine < 1) return;
    const position = view.state.doc.line(Math.min(props.goToLine, view.state.doc.lines)).from;
    const reveal = [EditorView.scrollIntoView(position, { y: "center" })];
    foldedRanges(view.state).between(position, position, (from, to) => {
      reveal.push(unfoldEffect.of({ from, to }));
    });
    view.dispatch({
      selection: EditorSelection.cursor(position),
      effects: reveal,
    });
    view.focus();
  }, [props.goToLine]);

  const foldComments = () => {
    const view = viewRef.current;
    if (!view) return;
    const ranges = latexFoldRanges(view.state.doc).filter((range) => range.comment);
    const covering = ranges.find(
      (range) =>
        range.from < view.state.selection.main.head && range.to >= view.state.selection.main.head,
    );
    view.dispatch({
      effects: ranges.map((range) => foldEffect.of(range)),
      selection: covering ? EditorSelection.cursor(covering.from) : undefined,
    });
    view.focus();
  };

  return (
    <div className={`flex min-h-0 flex-col ${props.className ?? ""}`}>
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-3 py-1 text-[11px] text-muted">
        <span>折叠</span>
        <button
          type="button"
          onClick={() => {
            const view = viewRef.current;
            if (!view) return;
            const line = view.state.doc.lineAt(view.state.selection.main.head).number;
            const range = latexFoldRanges(view.state.doc)
              .filter(
                (fold) => fold.startLine <= line && view.state.doc.lineAt(fold.to).number >= line,
              )
              .at(-1);
            if (range)
              view.dispatch({
                selection: EditorSelection.cursor(range.from),
                effects: foldEffect.of(range),
              });
            else foldCode(view);
            view.focus();
          }}
          className="hover:text-foreground"
          title="折叠光标所在章节或环境（⌘⌥[）"
        >
          当前块
        </button>
        <button
          type="button"
          onClick={foldComments}
          className="hover:text-foreground"
          title="包括多行注释和单条长注释；不修改文件内容"
        >
          注释
        </button>
        <button
          type="button"
          onClick={() => {
            if (viewRef.current) unfoldCode(viewRef.current);
          }}
          className="hover:text-foreground"
          title="展开光标所在块（⌘⌥]）"
        >
          展开当前
        </button>
        <button
          type="button"
          onClick={() => {
            if (viewRef.current) unfoldAll(viewRef.current);
          }}
          className="hover:text-foreground"
        >
          全部展开
        </button>
      </div>
      <div ref={container} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
});
