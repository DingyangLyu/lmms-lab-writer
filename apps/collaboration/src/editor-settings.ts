/**
 * The few editor settings the web offers (the desktop has a full dialog): text size, wrapping,
 * line numbers, boxes around full-width punctuation and spell checking. Kept per browser.
 */
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "@lmms-lab/workbench";
import { useCallback, useEffect, useState } from "react";

export type WebEditorSettings = Pick<
  EditorSettings,
  "fontSize" | "wordWrap" | "lineNumbers" | "highlightAmbiguousUnicode" | "autoClosingBrackets"
> & {
  /** The browser's English checker on the prose of .tex files; see spellcheck.ts. */
  spellcheck: boolean;
  /** The project page's colours; "system" follows the computer's setting. */
  theme: "light" | "dark" | "system";
  /** Vim key bindings in the editor. */
  vim: boolean;
};
const KEY = "writer-editor-settings";
const CHANGED = "writer-editor-settings";
export const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 22];

export function readEditorSettings(): WebEditorSettings {
  const fallback: WebEditorSettings = {
    fontSize: DEFAULT_EDITOR_SETTINGS.fontSize,
    wordWrap: DEFAULT_EDITOR_SETTINGS.wordWrap,
    lineNumbers: DEFAULT_EDITOR_SETTINGS.lineNumbers,
    highlightAmbiguousUnicode: DEFAULT_EDITOR_SETTINGS.highlightAmbiguousUnicode,
    autoClosingBrackets: "always",
    spellcheck: true,
    theme: "light",
    vim: false,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!saved || typeof saved !== "object") return fallback;
    return {
      fontSize: FONT_SIZES.includes(saved.fontSize) ? saved.fontSize : fallback.fontSize,
      wordWrap: saved.wordWrap === "off" ? "off" : "on",
      lineNumbers: saved.lineNumbers === "off" ? "off" : "on",
      highlightAmbiguousUnicode: saved.highlightAmbiguousUnicode === true,
      autoClosingBrackets: saved.autoClosingBrackets === "never" ? "never" : "always",
      spellcheck: saved.spellcheck !== false,
      theme: saved.theme === "dark" || saved.theme === "system" ? saved.theme : "light",
      vim: saved.vim === true,
    };
  } catch {
    return fallback;
  }
}

/** The settings, shared by every editor and menu on the page. */
export function useEditorSettings() {
  const [settings, setSettings] = useState(readEditorSettings);
  useEffect(() => {
    const changed = () => setSettings(readEditorSettings());
    window.addEventListener(CHANGED, changed);
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener(CHANGED, changed);
      window.removeEventListener("storage", changed);
    };
  }, []);
  const change = useCallback((patch: Partial<WebEditorSettings>) => {
    const next = { ...readEditorSettings(), ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* Kept for this page only. */
    }
    setSettings(next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return [settings, change] as const;
}

/** Whether the page shows dark: the setting, or the computer's when it says "system". */
export function useDarkTheme(theme: WebEditorSettings["theme"]) {
  const query =
    typeof matchMedia === "undefined" ? null : matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = useState(() => !!query?.matches);
  useEffect(() => {
    if (!query) return;
    const changed = () => setSystemDark(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, [query]);
  return theme === "dark" || (theme === "system" && systemDark);
}
