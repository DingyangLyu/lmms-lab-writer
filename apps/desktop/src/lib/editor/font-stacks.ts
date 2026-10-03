const CJK_MONO_FONTS = [
  '"Maple Mono NF CN"',
  '"Maple Mono SC NF"',
  '"Sarasa Mono SC"',
  '"LXGW WenKai Mono"',
  '"Noto Sans Mono CJK SC"',
  '"Source Han Mono SC"',
  '"WenQuanYi Zen Hei Mono"',
];

const CJK_SANS_FALLBACK_FONTS = [
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Microsoft YaHei UI"',
  '"Microsoft YaHei"',
  '"Noto Sans CJK SC"',
];

const APPLE_GOOGLE_MONO_FONTS = [
  '"SF Mono"',
  "SFMono-Regular",
  '"SF Pro Mono"',
  '"Google Sans Code"',
  '"Roboto Mono"',
  "var(--font-geist-mono)",
  "ui-monospace",
  "Menlo",
  "Consolas",
  '"Liberation Mono"',
  '"Courier New"',
];

// Match the familiar Overleaf code-editor stack before falling back to a CJK face.
const OVERLEAF_EDITOR_FONTS = [
  '"Monaco"',
  '"Menlo"',
  '"Consolas"',
  '"Lucida Console"',
  '"Source Code Pro"',
];

const TERMINAL_NERD_MONO_FONTS = [
  '"FiraCode Nerd Font Mono"',
  '"FiraCode Nerd Font"',
  '"Fira Code Nerd Font Mono"',
  '"Fira Code Nerd Font"',
  '"JetBrainsMono Nerd Font Mono"',
  '"JetBrainsMono Nerd Font"',
  '"MesloLGS NF"',
  '"Hack Nerd Font Mono"',
  '"CaskaydiaCove Nerd Font Mono"',
  '"Symbols Nerd Font Mono"',
];

export const EDITOR_MONO_FONT_FAMILY = [
  ...OVERLEAF_EDITOR_FONTS,
  ...CJK_SANS_FALLBACK_FONTS,
  ...CJK_MONO_FONTS,
  "monospace",
].join(", ");

export const TERMINAL_MONO_FONT_FAMILY = [
  ...TERMINAL_NERD_MONO_FONTS,
  ...APPLE_GOOGLE_MONO_FONTS,
  ...CJK_MONO_FONTS,
  ...CJK_SANS_FALLBACK_FONTS,
  "monospace",
].join(", ");

export function resolveMonoFontFamily(customFontFamily?: string | null): string {
  const trimmedFontFamily = customFontFamily?.trim();
  if (!trimmedFontFamily) {
    return EDITOR_MONO_FONT_FAMILY;
  }

  return `${trimmedFontFamily}, ${EDITOR_MONO_FONT_FAMILY}`;
}

function normalizeFontFamilyName(fontFamily: string): string {
  return fontFamily.replaceAll('"', "").replaceAll("'", "").trim().toLowerCase();
}

function quoteFontFamilyName(fontFamily: string): string {
  const trimmedFontFamily = fontFamily.trim();
  if (
    !trimmedFontFamily ||
    trimmedFontFamily.includes(",") ||
    trimmedFontFamily.startsWith("var(")
  ) {
    return trimmedFontFamily;
  }

  if (
    (trimmedFontFamily.startsWith('"') && trimmedFontFamily.endsWith('"')) ||
    (trimmedFontFamily.startsWith("'") && trimmedFontFamily.endsWith("'"))
  ) {
    return trimmedFontFamily;
  }

  return `"${trimmedFontFamily.replaceAll('"', '\\"')}"`;
}

export function resolveTerminalFontFamily(customFontFamily?: string | null): string {
  const trimmedFontFamily = customFontFamily?.trim();
  if (!trimmedFontFamily) {
    return TERMINAL_MONO_FONT_FAMILY;
  }

  const normalizedName = normalizeFontFamilyName(trimmedFontFamily);
  const isFiraCodeNerdFont =
    normalizedName === "firacode nerd font" ||
    normalizedName === "firacode nerd font mono" ||
    normalizedName === "firacode nerd font propo" ||
    normalizedName === "fira code nerd font" ||
    normalizedName === "fira code nerd font mono" ||
    normalizedName === "fira code nerd font propo";

  if (isFiraCodeNerdFont) {
    return `"FiraCode Nerd Font Mono", "FiraCode Nerd Font", ${TERMINAL_MONO_FONT_FAMILY}`;
  }

  return `${quoteFontFamilyName(trimmedFontFamily)}, ${TERMINAL_MONO_FONT_FAMILY}`;
}
