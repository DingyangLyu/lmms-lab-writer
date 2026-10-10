import { describe, expect, it } from "vitest";
import { findSymbols, LATEX_SYMBOLS, symbolInsertion } from "./symbols";

describe("symbol palette", () => {
  it("finds symbols by command, glyph and description, within a category", () => {
    expect(findSymbols("alpha").map((s) => s.command)).toEqual(["\\alpha"]);
    expect(findSymbols("\\leq")[0]?.glyph).toBe("≤");
    expect(findSymbols("≤")[0]?.command).toBe("\\leq");
    expect(findSymbols("integral").map((s) => s.command)).toContain("\\int");
    expect(findSymbols("", "greek")).toHaveLength(40);
    expect(new Set(LATEX_SYMBOLS.map((s) => `${s.category}${s.command}`)).size).toBe(
      LATEX_SYMBOLS.length,
    );
  });
  it("keeps a following letter from running into the command", () => {
    expect(symbolInsertion("\\alpha", "x")).toBe("\\alpha ");
    expect(symbolInsertion("\\alpha", "_")).toBe("\\alpha");
    expect(symbolInsertion("\\mathbb{R}", "x")).toBe("\\mathbb{R}");
  });
});
