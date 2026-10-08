/**
 * Chinese/English interface text for the desktop and collaboration apps.
 *
 * Each app passes its own dictionaries: flat keys, Chinese as the reference and an English table
 * that must cover every key. Templates take `{name}` placeholders and `{count|one|other}` for
 * English plurals.
 */
import { useCallback, useSyncExternalStore } from "react";

export type Locale = "zh" | "en";
export const LOCALES: readonly Locale[] = ["zh", "en"];
export type Params = Record<string, string | number>;

/** A saved choice wins; otherwise the first Chinese or English system language; else English. */
export function detectLocale(
  saved: string | null | undefined,
  languages: readonly string[],
): Locale {
  if (saved === "zh" || saved === "en") return saved;
  for (const language of languages) {
    if (/^zh\b/i.test(language)) return "zh";
    if (/^en\b/i.test(language)) return "en";
  }
  return "en";
}

export function format(template: string, params: Params = {}): string {
  return template.replace(/\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g, (match, name, one, other) => {
    const value = params[name];
    if (value === undefined) return match;
    if (one === undefined) return String(value);
    return value === 1 ? one : other;
  });
}

export function createI18n<M extends Record<string, string>>(options: {
  messages: { zh: M; en: { [K in keyof M]: string } };
  /** localStorage key for the user's choice. */
  storageKey: string;
}) {
  const listeners = new Set<() => void>();
  let current: Locale | null = null;

  const getLocale = (): Locale => {
    if (current) return current;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(options.storageKey);
    } catch {
      // Private mode or no storage: fall back to the system language.
    }
    const languages =
      typeof navigator === "undefined"
        ? []
        : navigator.languages?.length
          ? navigator.languages
          : [navigator.language];
    current = detectLocale(saved, languages);
    return current;
  };
  const setLocale = (locale: Locale) => {
    current = locale;
    try {
      localStorage.setItem(options.storageKey, locale);
    } catch {
      // The choice then lasts for this session only.
    }
    if (typeof document !== "undefined")
      document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const translate = (locale: Locale, key: keyof M & string, params?: Params) =>
    format(options.messages[locale][key] ?? options.messages.zh[key] ?? key, params);

  /** Server rendering and hydration use Chinese; the client then switches to the detected locale. */
  function useI18n() {
    const locale = useSyncExternalStore(subscribe, getLocale, () => "zh" as const);
    const t = useCallback(
      (key: keyof M & string, params?: Params) => translate(locale, key, params),
      [locale],
    );
    return { locale, setLocale, t };
  }

  return {
    useI18n,
    getLocale,
    setLocale,
    /** For code outside components (toasts from plain functions, request headers). */
    t: (key: keyof M & string, params?: Params) => translate(getLocale(), key, params),
  };
}
