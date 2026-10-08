import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n, detectLocale, dictionaryProblems, format } from "./index";

describe("detectLocale", () => {
  it("prefers the saved choice, then the first Chinese or English system language", () => {
    expect(detectLocale("en", ["zh-CN"])).toBe("en");
    expect(detectLocale(null, ["ja-JP", "zh-TW", "en-US"])).toBe("zh");
    expect(detectLocale("fr", ["en-GB"])).toBe("en");
    expect(detectLocale(null, ["ja-JP"])).toBe("en");
  });
});

describe("format", () => {
  it("fills placeholders and English plurals, leaving unknown names visible", () => {
    expect(format("已同步 {count} 个文件", { count: 3 })).toBe("已同步 3 个文件");
    expect(format("{count} {count|file|files} synced", { count: 1 })).toBe("1 file synced");
    expect(format("{count} {count|file|files} synced", { count: 2 })).toBe("2 files synced");
    expect(format("Hello {name}")).toBe("Hello {name}");
  });
});

describe("createI18n", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("detects once, remembers the choice and notifies subscribers through setLocale", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    vi.stubGlobal("navigator", { languages: ["en-US"], language: "en-US" });
    const i18n = createI18n({
      messages: { zh: { hello: "你好，{name}" }, en: { hello: "Hello, {name}" } },
      storageKey: "test-locale",
    });
    expect(i18n.t("hello", { name: "Ada" })).toBe("Hello, Ada");
    i18n.setLocale("zh");
    expect(store.get("test-locale")).toBe("zh");
    expect(i18n.t("hello", { name: "Ada" })).toBe("你好，Ada");
  });
});

describe("dictionaryProblems", () => {
  it("reports duplicate keys, missing languages and mismatched placeholders", () => {
    expect(
      dictionaryProblems({
        "a.ts": {
          aZh: { "a.one": "一 {name}", "a.count": "{count} 个", "a.only": "只有中文" },
          aEn: { "a.one": "One", "a.count": "{count} {count|item|items}" },
        },
        "b.ts": { bZh: { "a.one": "重复" }, bEn: { "a.one": "Again", "b.extra": "Extra" } },
      }),
    ).toEqual([
      "a.one: English lacks {name}",
      "a.ts: a.only has no English",
      "b.ts: b.extra has no Chinese",
      "a.one is defined in a.ts and b.ts",
    ]);
  });
});
