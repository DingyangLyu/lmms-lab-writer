import { describe, expect, it } from "vitest";
import { resolveTerminalFontFamily } from "./font-stacks";

describe("resolveTerminalFontFamily", () => {
  it("prefers the FiraCode Nerd Font Mono face for FiraCode Nerd Font input", () => {
    expect(
      resolveTerminalFontFamily("FiraCode Nerd Font").startsWith('"FiraCode Nerd Font Mono"'),
    ).toBe(true);
  });

  it("normalizes FiraCode Nerd Font Mono input to a quoted mono face", () => {
    expect(
      resolveTerminalFontFamily("FiraCode Nerd Font Mono").startsWith('"FiraCode Nerd Font Mono"'),
    ).toBe(true);
  });

  it("maps the proportional FiraCode Nerd Font face back to mono for terminal use", () => {
    expect(
      resolveTerminalFontFamily("FiraCode Nerd Font Propo").startsWith('"FiraCode Nerd Font Mono"'),
    ).toBe(true);
  });

  it("quotes simple custom font family names with spaces", () => {
    expect(resolveTerminalFontFamily("JetBrains Mono").startsWith('"JetBrains Mono"')).toBe(true);
  });
});
