import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_MINIMAP_SETTINGS,
  type EditorSettings,
  type EditorTheme,
} from "./types";

const STORAGE_KEY = "editor-settings";

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(clampNumber(value, fallback, min, max));
}

function sanitizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

// Migration helper for backward compatibility
function migrateSettings(parsed: Record<string, unknown>): EditorSettings {
  const settings = { ...DEFAULT_EDITOR_SETTINGS, ...parsed };

  // Remove legacy theme field (now auto-follows app mode)
  if ("theme" in settings) {
    delete (settings as Record<string, unknown>).theme;
  }

  // Migrate old boolean minimap format to new object format
  if (typeof parsed.minimap === "boolean") {
    settings.minimap = {
      ...DEFAULT_MINIMAP_SETTINGS,
      enabled: parsed.minimap,
    };
  } else if (parsed.minimap && typeof parsed.minimap === "object") {
    settings.minimap = { ...DEFAULT_MINIMAP_SETTINGS, ...parsed.minimap };
  }

  if (typeof parsed.gitAutoFetchIntervalSeconds === "number") {
    settings.gitAutoFetchIntervalSeconds = Math.min(
      3600,
      Math.max(15, Math.round(parsed.gitAutoFetchIntervalSeconds)),
    );
  }

  settings.fontFamily = sanitizeString(settings.fontFamily);
  settings.fontSize = clampInteger(settings.fontSize, DEFAULT_EDITOR_SETTINGS.fontSize, 8, 32);
  settings.lineHeight =
    Math.round(
      clampNumber(settings.lineHeight, DEFAULT_EDITOR_SETTINGS.lineHeight, 1.0, 3.0) * 10,
    ) / 10;
  settings.highlightAmbiguousUnicode =
    typeof parsed.highlightAmbiguousUnicode === "boolean"
      ? parsed.highlightAmbiguousUnicode
      : DEFAULT_EDITOR_SETTINGS.highlightAmbiguousUnicode;

  if (settings.terminalShellMode !== "auto" && settings.terminalShellMode !== "custom") {
    settings.terminalShellMode = DEFAULT_EDITOR_SETTINGS.terminalShellMode;
  }

  settings.terminalShellPath = sanitizeString(
    settings.terminalShellPath,
    DEFAULT_EDITOR_SETTINGS.terminalShellPath,
  );
  settings.terminalFontFamily = sanitizeString(settings.terminalFontFamily);
  settings.terminalFontSize = clampInteger(
    settings.terminalFontSize,
    DEFAULT_EDITOR_SETTINGS.terminalFontSize,
    8,
    32,
  );
  settings.terminalLineHeight =
    Math.round(
      clampNumber(
        settings.terminalLineHeight,
        DEFAULT_EDITOR_SETTINGS.terminalLineHeight,
        1.0,
        3.0,
      ) * 10,
    ) / 10;

  return settings as EditorSettings;
}

export function useEditorSettings() {
  const { resolvedTheme } = useTheme();

  const [settings, setSettings] = useState<EditorSettings>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_EDITOR_SETTINGS;
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return migrateSettings(parsed);
      }
    } catch {
      // Ignore parse errors
    }
    return DEFAULT_EDITOR_SETTINGS;
  });

  // Another window changed the settings.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        setSettings(migrateSettings(JSON.parse(event.newValue)));
      } catch {
        // Ignore parse errors
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Derive editor theme from app theme
  const editorTheme: EditorTheme = resolvedTheme === "dark" ? "one-dark" : "one-light";

  // Persist settings to localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage errors
    }
  }, [settings]);

  const updateSettings = useCallback((updates: Partial<EditorSettings>) => {
    setSettings((prev) => ({ ...prev, ...updates }));
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_EDITOR_SETTINGS);
  }, []);

  return {
    settings,
    editorTheme,
    updateSettings,
    resetSettings,
  };
}
