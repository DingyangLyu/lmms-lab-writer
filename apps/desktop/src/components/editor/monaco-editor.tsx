"use client";

import "@/lib/monaco/config";

import Editor, { type Monaco, type OnChange, type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveMonoFontFamily } from "@/lib/editor/font-stacks";
import type { EditorTextRange } from "@/lib/editor/selection-context";
import { type SourceMark, useSourceAnnotations } from "@/lib/editor/source-annotations";
import type { EditorSettings, EditorTheme } from "@/lib/editor/types";
import { registerLaTeXLanguage } from "@/lib/monaco/latex";
import { defineEditorThemes } from "@/lib/monaco/themes";
import { LatexSourceEditor } from "./latex-source-editor";
import { i18n, useI18n } from "@/lib/i18n";

type Props = {
  project?: string;
  path?: string;
  annotationMarks?: SourceMark[];
  annotationContent?: string;
  onAnnotationClick?: (id: string) => void;
  onAnnotate?: (ranges: EditorTextRange[], content: string) => void;
  content?: string;
  readOnly?: boolean;
  className?: string;
  language?: string;
  editorSettings?: Partial<EditorSettings>;
  editorTheme?: EditorTheme;
  onContentChange?: (content: string, previous?: string) => void;
  goToLine?: number;
  onSelectionChange?: (ranges: EditorTextRange[] | null) => void;
};

type VimModeController = {
  dispose: () => void;
};

function detectLanguage(lang: string): string {
  const languageMap: Record<string, string> = {
    tex: "latex",
    latex: "latex",
    bib: "bibtex",
    js: "javascript",
    ts: "typescript",
    jsx: "javascript",
    tsx: "typescript",
    py: "python",
    md: "markdown",
    json: "json",
    css: "css",
    html: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  return languageMap[lang.toLowerCase()] || lang;
}

export const MonacoEditor = memo(function SourceEditor(props: Props) {
  const { t } = useI18n();
  const { marks, annotationContent, notes } = useSourceAnnotations(
    props.project,
    props.path,
    props.content,
  );
  const [ranges, setRanges] = useState<EditorTextRange[] | null>(null);
  const [style, setStyle] = useState<"highlight" | "underline">("highlight");
  const annotate = (selection: EditorTextRange[], content: string) => {
    if (props.project && props.path)
      notes?.beginTextDraft(
        { project: props.project, path: props.path, ranges: selection },
        content,
        style,
      );
  };
  const child = {
    ...props,
    className: "h-full",
    annotationMarks: marks,
    annotationContent,
    onAnnotationClick: (id: string) => notes?.focusAnnotation(id),
    onAnnotate: annotate,
    onSelectionChange: (selection: EditorTextRange[] | null) => {
      setRanges(selection);
      props.onSelectionChange?.(selection);
    },
  };
  const engine =
    detectLanguage(props.language ?? "latex") === "latex" && !props.editorSettings?.vimMode ? (
      <LatexSourceEditor {...child} />
    ) : (
      <MonacoTextEditor {...child} />
    );
  if (!props.project || !props.path || props.readOnly) return engine;
  return (
    <div className={`flex min-h-0 flex-col ${props.className || ""}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1 text-xs">
        <button
          type="button"
          disabled={!ranges?.length}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (ranges) annotate(ranges, props.content || "");
          }}
          className="border border-border px-2 py-1 disabled:opacity-40"
        >
          {t("monaco.addComment")}
        </button>
        <select
          aria-label={t("monaco.howToMarkComments")}
          value={style}
          onChange={(e) => setStyle(e.target.value as typeof style)}
          className="border border-border bg-background px-1 py-1"
        >
          <option value="highlight">{t("monaco.highlight")}</option>
          <option value="underline">{t("monaco.underline")}</option>
        </select>
        <span
          className="min-w-0 truncate text-muted"
          title={t("monaco.selectTextToAddACommentCtrlClickAMarkToO")}
        >
          {t("monaco.countCountCommentCommentsCtrlClickAMarkT", { count: marks.length })}
        </span>
      </div>
      <div className="min-h-0 flex-1">{engine}</div>
    </div>
  );
});

const MonacoTextEditor = memo(function MonacoTextEditor({
  content = "",
  readOnly = false,
  className = "",
  language = "latex",
  editorSettings,
  editorTheme = "one-light",
  onContentChange,
  goToLine,
  onSelectionChange,
  annotationMarks = [],
  onAnnotationClick,
  onAnnotate,
}: Props) {
  const selectionCallbackRef = useRef(onSelectionChange);
  useEffect(() => {
    selectionCallbackRef.current = onSelectionChange;
  }, [onSelectionChange]);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const isExternalUpdateRef = useRef(false);
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = editorRef.current?.getModel()?.getValue() ?? content;
  }, [content]);
  const vimModeRef = useRef<VimModeController | null>(null);
  const vimStatusRef = useRef<HTMLDivElement | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const loadingRows = [70, 45, 60, 80, 35, 55, 40, 65].map((width) => ({
    id: `monaco-loading-${width}`,
    width,
  }));

  const annotationsRef = useRef({
    marks: annotationMarks,
    click: onAnnotationClick,
    annotate: onAnnotate,
  });
  annotationsRef.current = {
    marks: annotationMarks,
    click: onAnnotationClick,
    annotate: onAnnotate,
  };
  const markCollection = useRef<editor.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    const ed = editorRef.current,
      model = ed?.getModel();
    if (!ed || !model || !editorReady) return;
    markCollection.current ??= ed.createDecorationsCollection();
    markCollection.current.set(
      annotationMarks.flatMap((note) =>
        note.ranges
          .filter((r) => r.end > r.start && r.state !== "deleted")
          .map((r) => {
            const a = model.getPositionAt(r.start),
              b = model.getPositionAt(r.end);
            return {
              range: {
                startLineNumber: a.lineNumber,
                startColumn: a.column,
                endLineNumber: b.lineNumber,
                endColumn: b.column,
              },
              options: {
                inlineClassName: `writer-note-${note.style} ${note.resolved ? "writer-note-resolved" : ""}`,
                hoverMessage: {
                  value: `${note.resolved ? i18n.t("monaco.resolved") : ""}${note.comment.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&")}\n\n${i18n.t("monaco.ctrlClickToOpenTheComment")}`,
                },
                stickiness: 1,
              },
            };
          }),
      ),
    );
  }, [annotationMarks, editorReady]);
  const pendingGoToLineRef = useRef<number>(0);

  const handleEditorDidMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    setEditorReady(true);

    // Apply any pending goToLine that arrived before the editor was ready
    if (pendingGoToLineRef.current > 0) {
      const line = pendingGoToLineRef.current;
      pendingGoToLineRef.current = 0;
      setTimeout(() => {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
        const decorations = editor.deltaDecorations(
          [],
          [
            {
              range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
              options: {
                isWholeLine: true,
                className: "synctex-line-highlight",
                overviewRuler: { color: "rgba(255, 200, 0, 0.6)", position: 1 },
              },
            },
          ],
        );
        setTimeout(() => editor.deltaDecorations(decorations, []), 1500);
      }, 50);
    }

    defineEditorThemes(monaco);
    registerLaTeXLanguage(monaco);

    editor.focus();
    editor.addAction({
      id: "writer-add-annotation",
      label: i18n.t("monaco.addComment2"),
      contextMenuGroupId: "navigation",
      precondition: "editorHasSelection",
      run: (ed) => {
        const model = ed.getModel();
        if (!model) return;
        const ranges = (ed.getSelections() || [])
          .filter((r) => !r.isEmpty())
          .map((r) => ({
            startLineNumber: r.startLineNumber,
            startColumn: r.startColumn,
            endLineNumber: r.endLineNumber,
            endColumn: r.endColumn,
            startOffset: model.getOffsetAt(r.getStartPosition()),
            endOffset: model.getOffsetAt(r.getEndPosition()),
            text: model.getValueInRange(r),
          }));
        if (ranges.length) annotationsRef.current.annotate?.(ranges, model.getValue());
      },
    });
    editor.onMouseDown((event) => {
      if (!(event.event.metaKey || event.event.ctrlKey) || !event.target.position) return;
      const model = editor.getModel();
      if (!model) return;
      const offset = model.getOffsetAt(event.target.position);
      const note = annotationsRef.current.marks.find((n) =>
        n.ranges.some((r) => r.start <= offset && offset < r.end),
      );
      if (note) annotationsRef.current.click?.(note.id);
    });

    editor.addAction({
      id: "toggle-latex-comment",
      label: "Toggle LaTeX Comment",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash],
      run: (ed) => {
        const selection = ed.getSelection();
        if (!selection) return;

        const model = ed.getModel();
        if (!model) return;

        const edits: editor.IIdentifiedSingleEditOperation[] = [];

        for (
          let lineNumber = selection.startLineNumber;
          lineNumber <= selection.endLineNumber;
          lineNumber++
        ) {
          const lineContent = model.getLineContent(lineNumber);
          const trimmedLine = lineContent.trimStart();
          const leadingSpaces = lineContent.length - trimmedLine.length;

          if (trimmedLine.startsWith("%")) {
            const commentLength = trimmedLine.startsWith("% ") ? 2 : 1;
            edits.push({
              range: {
                startLineNumber: lineNumber,
                startColumn: leadingSpaces + 1,
                endLineNumber: lineNumber,
                endColumn: leadingSpaces + 1 + commentLength,
              },
              text: "",
            });
          } else {
            edits.push({
              range: {
                startLineNumber: lineNumber,
                startColumn: leadingSpaces + 1,
                endLineNumber: lineNumber,
                endColumn: leadingSpaces + 1,
              },
              text: "% ",
            });
          }
        }

        ed.executeEdits("toggle-comment", edits);
      },
    });
  }, []);

  const handleChange: OnChange = useCallback(
    (value) => {
      if (isExternalUpdateRef.current) return;
      if (value !== undefined) {
        const previous = contentRef.current;
        contentRef.current = value;
        onContentChange?.(value, previous);
      }
    },
    [onContentChange],
  );

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    defineEditorThemes(monaco);
    registerLaTeXLanguage(monaco);
  }, []);

  useEffect(() => {
    const ed = editorRef.current;
    if (!editorReady || !ed || readOnly) return;
    let emitted = false;
    const capture = () => {
      // Losing focus to the chat input must not clear the user's selection.
      if (!ed.hasTextFocus()) return;
      const model = ed.getModel();
      if (!model) return;
      const bomLength = model.getValueLength(undefined, true) - model.getValueLength();
      const ranges = (ed.getSelections() || [])
        .filter((range) => !range.isEmpty())
        .map((range) => ({
          startLineNumber: range.startLineNumber,
          startColumn: range.startColumn,
          endLineNumber: range.endLineNumber,
          endColumn: range.endColumn,
          startOffset: model.getOffsetAt(range.getStartPosition()) + bomLength,
          endOffset: model.getOffsetAt(range.getEndPosition()) + bomLength,
          text: model.getValueInRange(range),
        }));
      if (ranges.length) {
        emitted = true;
        selectionCallbackRef.current?.(ranges);
      } else if (emitted) {
        emitted = false;
        selectionCallbackRef.current?.(null);
      }
    };
    const cursor = ed.onDidChangeCursorSelection(capture);
    const focus = ed.onDidFocusEditorText(capture);
    const content = ed.onDidChangeModelContent(() => {
      if (emitted) {
        emitted = false;
        selectionCallbackRef.current?.(null);
      }
    });
    capture();
    return () => {
      cursor.dispose();
      focus.dispose();
      content.dispose();
      if (emitted) selectionCallbackRef.current?.(null);
    };
  }, [editorReady, readOnly]);

  useEffect(() => {
    if (monacoRef.current && editorTheme) {
      monacoRef.current.editor.setTheme(editorTheme);
    }
  }, [editorTheme]);

  useEffect(() => {
    if (!goToLine || goToLine <= 0) return;

    const ed = editorRef.current;
    if (!ed) {
      // Editor not ready yet — store for when it mounts
      pendingGoToLineRef.current = goToLine;
      return;
    }

    ed.revealLineInCenter(goToLine);
    ed.setPosition({ lineNumber: goToLine, column: 1 });
    ed.focus();

    // Briefly highlight the line
    const decorations = ed.deltaDecorations(
      [],
      [
        {
          range: {
            startLineNumber: goToLine,
            startColumn: 1,
            endLineNumber: goToLine,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: "synctex-line-highlight",
            overviewRuler: {
              color: "rgba(255, 200, 0, 0.6)",
              position: 1,
            },
          },
        },
      ],
    );

    const timer = setTimeout(() => {
      ed.deltaDecorations(decorations, []);
    }, 1500);

    return () => clearTimeout(timer);
  }, [goToLine]);

  useEffect(() => {
    const statusNode = vimStatusRef.current;
    if (!editorReady || !editorRef.current || !statusNode) return;

    vimModeRef.current?.dispose();
    vimModeRef.current = null;
    statusNode.textContent = "";

    const shouldEnableVim = !!editorSettings?.vimMode && !readOnly;
    if (!shouldEnableVim) return;

    let cancelled = false;

    (async () => {
      try {
        const monacoVim = await import("monaco-vim");
        if (cancelled || !editorRef.current) return;

        vimModeRef.current?.dispose();
        vimModeRef.current = monacoVim.initVimMode(editorRef.current, statusNode);
        editorRef.current.focus();
      } catch (error) {
        console.error("Failed to enable Vim mode:", error);
      }
    })();

    return () => {
      cancelled = true;
      vimModeRef.current?.dispose();
      vimModeRef.current = null;
      statusNode.textContent = "";
    };
  }, [editorReady, editorSettings?.vimMode, readOnly]);

  useEffect(() => {
    return () => {
      vimModeRef.current?.dispose();
      vimModeRef.current = null;
    };
  }, []);

  const editorOptions = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({
      readOnly,
      fontSize: editorSettings?.fontSize ?? 14,
      fontFamily: resolveMonoFontFamily(editorSettings?.fontFamily),
      fontLigatures: false,
      lineNumbers: editorSettings?.lineNumbers ?? "on",
      lineHeight: editorSettings?.lineHeight ?? 1.6,
      letterSpacing: 0,
      renderWhitespace: editorSettings?.renderWhitespace ?? "selection",
      tabSize: editorSettings?.tabSize ?? 2,
      insertSpaces: editorSettings?.insertSpaces ?? true,
      wordWrap: editorSettings?.wordWrap ?? "off",
      wordWrapColumn: editorSettings?.wordWrapColumn ?? 80,
      unicodeHighlight: {
        nonBasicASCII: false,
        ambiguousCharacters: editorSettings?.highlightAmbiguousUnicode ?? false,
        invisibleCharacters: true,
      },
      wrappingIndent: "same",
      automaticLayout: true,
      minimap: {
        enabled: editorSettings?.minimap?.enabled ?? false,
        side: editorSettings?.minimap?.side ?? "right",
        size: editorSettings?.minimap?.size ?? "proportional",
        maxColumn: 120,
        renderCharacters: editorSettings?.minimap?.renderCharacters ?? false,
        scale: editorSettings?.minimap?.scale ?? 1,
        showSlider: editorSettings?.minimap?.showSlider ?? "mouseover",
      },
      scrollBeyondLastLine: false,
      smoothScrolling: editorSettings?.smoothScrolling ?? true,
      cursorBlinking: editorSettings?.cursorBlinking ?? "smooth",
      cursorSmoothCaretAnimation: "on",
      cursorStyle: editorSettings?.cursorStyle ?? "line",
      cursorWidth: 2,
      formatOnPaste: editorSettings?.formatOnPaste ?? false,
      formatOnType: editorSettings?.formatOnSave ?? false,
      autoClosingBrackets: editorSettings?.autoClosingBrackets ?? "languageDefined",
      autoClosingQuotes: editorSettings?.autoClosingQuotes ?? "languageDefined",
      renderLineHighlight: "line",
      renderLineHighlightOnlyWhenFocus: false,
      selectOnLineNumbers: true,
      folding: true,
      foldingStrategy: "auto",
      showFoldingControls: "always",
      matchBrackets: "always",
      bracketPairColorization: {
        enabled: false,
      },
      guides: {
        bracketPairs: true,
        bracketPairsHorizontal: false,
        indentation: true,
        highlightActiveIndentation: true,
      },
      suggest: {
        showKeywords: true,
        showSnippets: true,
        showFunctions: true,
        showConstants: true,
        showVariables: true,
        filterGraceful: true,
        localityBonus: true,
      },
      quickSuggestions: {
        other: true,
        comments: false,
        strings: true,
      },
      acceptSuggestionOnCommitCharacter: true,
      acceptSuggestionOnEnter: "on",
      snippetSuggestions: "inline",
      parameterHints: {
        enabled: true,
      },
      find: {
        addExtraSpaceOnTop: false,
        autoFindInSelection: "multiline",
        seedSearchStringFromSelection: "selection",
      },
      padding: {
        top: 16,
        bottom: 16,
      },
      scrollbar: {
        vertical: "visible",
        horizontal: "visible",
        useShadows: false,
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        arrowSize: 0,
      },
      overviewRulerBorder: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      contextmenu: true,
      mouseWheelZoom: true,
      dragAndDrop: true,
      links: true,
      colorDecorators: false,
      accessibilitySupport: "auto",
    }),
    [readOnly, editorSettings],
  );

  return (
    <div className={`relative flex flex-col ${className}`}>
      {editorSettings?.vimMode && !readOnly && (
        <div
          ref={vimStatusRef}
          className="pointer-events-none absolute right-3 top-3 z-10 border border-foreground bg-background px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider"
        />
      )}
      <Editor
        height="100%"
        language={detectLanguage(language)}
        value={content}
        theme={editorTheme}
        beforeMount={handleBeforeMount}
        onMount={handleEditorDidMount}
        onChange={handleChange}
        options={editorOptions}
        loading={
          <div className="flex flex-col h-full bg-background">
            <div className="flex-1 p-4 space-y-2">
              {loadingRows.map(({ id, width }) => (
                <div key={id} className="flex gap-4">
                  <div className="w-8 h-4 bg-surface-secondary animate-pulse" />
                  <div
                    className="flex-1 h-4 bg-surface-secondary animate-pulse"
                    style={{ width: `${width}%` }}
                  />
                </div>
              ))}
            </div>
          </div>
        }
      />
    </div>
  );
});
