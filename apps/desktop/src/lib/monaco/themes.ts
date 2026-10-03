"use client";

import type { Monaco } from "@monaco-editor/react";
import type { MonacoTheme } from "monaco-themes";
import githubDarkTheme from "./github-dark.json";
// Source: monaco-themes/themes/ (v0.4.8)
import githubLightTheme from "./github-light.json";

// Overleaf's default TextMate theme keeps prose uncolored and uses blue for
// commands, teal for reference keys/environment names, green for comments/math,
// and violet for literals/operators. Keep these rules
// scoped to LaTeX so other languages retain the imported GitHub themes.
// https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/source-editor/themes/cm6/textmate.json
const latexLightRules = [
  { token: "keyword.control.latex", foreground: "0000A2" },
  { token: "keyword.latex", foreground: "0000A2" },
  { token: "markup.heading.latex", foreground: "1C50AF" },
  { token: "comment.latex", foreground: "4C886B" },
  { token: "string.math.latex", foreground: "036A07" },
  { token: "operator.math.latex", foreground: "833FBA" },
  { token: "reference.key.latex", foreground: "318495" },
  { token: "entity.name.environment.latex", foreground: "318495" },
  { token: "delimiter.table.latex", foreground: "0000A2" },
  { token: "variable.parameter.latex", foreground: "24292E" },
  { token: "delimiter.bracket.latex", foreground: "687687" },
  { token: "constant.latex", foreground: "833FBA" },
  { token: "number.latex", foreground: "833FBA" },
];

// TextMate itself is a light theme. This dark counterpart uses the same
// semantic hierarchy, with lower-contrast colors on GitHub Dark's background.
const latexDarkRules = [
  { token: "keyword.control.latex", foreground: "9CC3F5" },
  { token: "keyword.latex", foreground: "9CC3F5" },
  { token: "markup.heading.latex", foreground: "B4C9FF" },
  { token: "comment.latex", foreground: "8BAE96" },
  { token: "string.math.latex", foreground: "A9C788" },
  { token: "operator.math.latex", foreground: "C7A5DB" },
  { token: "reference.key.latex", foreground: "77BDC5" },
  { token: "entity.name.environment.latex", foreground: "77BDC5" },
  { token: "delimiter.table.latex", foreground: "9CC3F5" },
  { token: "variable.parameter.latex", foreground: "C9D1D9" },
  { token: "delimiter.bracket.latex", foreground: "9BA8B4" },
  { token: "constant.latex", foreground: "C7A5DB" },
  { token: "number.latex", foreground: "C7A5DB" },
];

// Supplementary editor chrome colors not included in the base GitHub Light theme
const githubLightEditorColors: Record<string, string> = {
  "editor.foreground": "#24292e",
  "editor.selectionBackground": "#b5d5ff",
  "editor.lineHighlightBackground": "#f5f5f5",
  "editorLineNumber.foreground": "#666666",
  "editorLineNumber.activeForeground": "#24292e",
  "editorCursor.background": "#ffffff",
  "editor.selectionHighlightBackground": "#c8c8fa88",
  "editor.lineHighlightBorder": "#00000000",
  "editorBracketMatch.background": "#c8c8fa66",
  "editorBracketMatch.border": "#586069",
  "editorGutter.background": "#ffffff",
  "editorGutter.modifiedBackground": "#e36209",
  "editorGutter.addedBackground": "#22863a",
  "editorGutter.deletedBackground": "#b31d28",
  "scrollbar.shadow": "#00000000",
  "scrollbarSlider.background": "#d4d4d4",
  "scrollbarSlider.hoverBackground": "#a3a3a3",
  "scrollbarSlider.activeBackground": "#737373",
  "editorWidget.background": "#fafbfc",
  "editorWidget.border": "#e1e4e8",
  "editorWidget.foreground": "#24292e",
  "editorSuggestWidget.background": "#fafbfc",
  "editorSuggestWidget.border": "#e1e4e8",
  "editorSuggestWidget.foreground": "#24292e",
  "editorSuggestWidget.selectedBackground": "#e1e4e8",
  "editorSuggestWidget.highlightForeground": "#005cc5",
  "editorHoverWidget.background": "#fafbfc",
  "editorHoverWidget.border": "#e1e4e8",
  "editorHoverWidget.foreground": "#24292e",
  "editor.findMatchBackground": "#ffdf5d66",
  "editor.findMatchHighlightBackground": "#ffdf5d33",
  "editor.findMatchBorder": "#e36209",
  "editor.wordHighlightBackground": "#c8c8fa44",
  "editor.wordHighlightStrongBackground": "#c8c8fa66",
  "minimap.background": "#fafbfc",
  "minimap.selectionHighlight": "#c8c8fa",
  "minimapSlider.background": "#d4d4d420",
  "minimapSlider.hoverBackground": "#d4d4d440",
  "minimapSlider.activeBackground": "#d4d4d460",
  "editorOverviewRuler.border": "#e1e4e8",
  "editorOverviewRuler.findMatchForeground": "#e36209",
  "editorOverviewRuler.selectionHighlightForeground": "#005cc5",
  "editorError.foreground": "#b31d28",
  "editorWarning.foreground": "#e36209",
  "editorInfo.foreground": "#005cc5",
  "editorBracketHighlight.foreground1": "#005cc5",
  "editorBracketHighlight.foreground2": "#6f42c1",
  "editorBracketHighlight.foreground3": "#22863a",
  "editorBracketHighlight.unexpectedBracket.foreground": "#b31d28",
};

// Supplementary editor chrome colors - also overrides overly bright base theme values
const githubDarkEditorColors: Record<string, string> = {
  "editor.foreground": "#c9d1d9",
  "editorLineNumber.foreground": "#636e7b",
  "editorLineNumber.activeForeground": "#d1d5da",
  "editorCursor.background": "#24292e",
  "editor.selectionHighlightBackground": "#3b404866",
  "editor.lineHighlightBorder": "#00000000",
  "editorBracketMatch.background": "#3b404866",
  "editorBracketMatch.border": "#58a6ff",
  "editorGutter.background": "#24292e",
  "editorGutter.modifiedBackground": "#d29922",
  "editorGutter.addedBackground": "#56d364",
  "editorGutter.deletedBackground": "#f85149",
  "scrollbar.shadow": "#01040900",
  "scrollbarSlider.background": "#636e7b33",
  "scrollbarSlider.hoverBackground": "#636e7b55",
  "scrollbarSlider.activeBackground": "#636e7b77",
  "editorWidget.background": "#1b1f23",
  "editorWidget.border": "#3b4048",
  "editorWidget.foreground": "#c9d1d9",
  "editorSuggestWidget.background": "#1b1f23",
  "editorSuggestWidget.border": "#3b4048",
  "editorSuggestWidget.foreground": "#c9d1d9",
  "editorSuggestWidget.selectedBackground": "#3b4048",
  "editorSuggestWidget.highlightForeground": "#58a6ff",
  "editorHoverWidget.background": "#1b1f23",
  "editorHoverWidget.border": "#3b4048",
  "editorHoverWidget.foreground": "#c9d1d9",
  "editor.findMatchBackground": "#9e6a03aa",
  "editor.findMatchHighlightBackground": "#9e6a0355",
  "editor.findMatchBorder": "#d29922",
  "editor.wordHighlightBackground": "#3b404866",
  "editor.wordHighlightStrongBackground": "#3b404899",
  "minimap.background": "#24292e",
  "minimap.selectionHighlight": "#3b404899",
  "minimapSlider.background": "#636e7b20",
  "minimapSlider.hoverBackground": "#636e7b40",
  "minimapSlider.activeBackground": "#636e7b60",
  "editorOverviewRuler.border": "#3b4048",
  "editorOverviewRuler.findMatchForeground": "#d29922",
  "editorOverviewRuler.selectionHighlightForeground": "#a371f7",
  "editorError.foreground": "#f85149",
  "editorWarning.foreground": "#d29922",
  "editorInfo.foreground": "#58a6ff",
  "editorBracketHighlight.foreground1": "#58a6ff",
  "editorBracketHighlight.foreground2": "#a371f7",
  "editorBracketHighlight.foreground3": "#56d364",
  "editorBracketHighlight.unexpectedBracket.foreground": "#f85149",
};

export const defineEditorThemes = (monaco: Monaco) => {
  // GitHub Light theme - imported from monaco-themes package
  const lightTheme = githubLightTheme as MonacoTheme;
  monaco.editor.defineTheme("one-light", {
    ...lightTheme,
    rules: [...lightTheme.rules, ...latexLightRules],
    colors: {
      ...lightTheme.colors,
      ...githubLightEditorColors,
    },
  });

  // GitHub Dark theme - imported from monaco-themes package
  const darkTheme = githubDarkTheme as MonacoTheme;
  monaco.editor.defineTheme("one-dark", {
    ...darkTheme,
    rules: [...darkTheme.rules, ...latexDarkRules],
    colors: {
      ...darkTheme.colors,
      ...githubDarkEditorColors,
    },
  });
};
