/**
 * The few editor settings the web offers (the desktop has a full dialog): text size, wrapping,
 * line numbers, boxes around full-width punctuation and spell checking. Kept per browser.
 */
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "@lmms-lab/workbench";
import { useCallback, useEffect, useState } from "react";

export type WebEditorSettings = Pick<
  EditorSettings,
  "fontSize" | "wordWrap" | "lineNumbers" | "highlightAmbiguousUnicode"
> & {
  /** The browser's English checker on the prose of .tex files; see spellcheck.ts. */
  spellcheck: boolean;
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
    spellcheck: true,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!saved || typeof saved !== "object") return fallback;
    return {
      fontSize: FONT_SIZES.includes(saved.fontSize) ? saved.fontSize : fallback.fontSize,
      wordWrap: saved.wordWrap === "off" ? "off" : "on",
      lineNumbers: saved.lineNumbers === "off" ? "off" : "on",
      highlightAmbiguousUnicode: saved.highlightAmbiguousUnicode === true,
      spellcheck: saved.spellcheck !== false,
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
