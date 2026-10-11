/**
 * Which TeX engine a project needs when nobody chose one, decided the same way on the web
 * (from the shared sources) and on the desktop (apps/desktop/src-tauri/src/commands/
 * latex_build.rs, from the folder): the main file's `% !TEX program = …` line; else what the
 * main file and the files it inputs ask for — luatexja → LuaLaTeX; ctex, xeCJK, fontspec,
 * polyglossia or unicode-math → XeLaTeX; Chinese or Japanese text → XeLaTeX — else pdfLaTeX.
 * fixtures/engine-cases.json is checked on both sides; change them together.
 */
export type TexEngine = "pdflatex" | "xelatex" | "lualatex" | "tectonic" | "latexmk";
const MAGIC: readonly TexEngine[] = ["pdflatex", "xelatex", "lualatex", "tectonic", "latexmk"];
const XE_PACKAGES = [
  "ctex",
  "xeCJK",
  "fontspec",
  "polyglossia",
  "unicode-math",
  "xltxtra",
  "xunicode",
];
const XE_CLASSES = ["ctexart", "ctexbook", "ctexrep", "ctexbeamer"];
/** Files followed through \input and \include, at most. */
const MAX_FILES = 100;

/** `% !TEX program = xelatex` (or TS-program) in the first 30 lines. */
export function magicEngine(text: string): TexEngine | null {
  for (const line of text.split("\n").slice(0, 30)) {
    const lower = line.toLowerCase();
    if (!lower.trimStart().startsWith("%") || !lower.includes("!tex") || !lower.includes("program"))
      continue;
    const engine = lower.split("=")[1]?.trim() as TexEngine | undefined;
    if (engine && MAGIC.includes(engine)) return engine;
  }
  return null;
}

/** Each line up to its first unescaped `%`. */
export function withoutComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let escaped = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "%" && !escaped) return line.slice(0, i);
        escaped = c === "\\" ? !escaped : false;
      }
      return line;
    })
    .join("\n");
}

/** The braced arguments of `\command[options]{…}` (not of longer command names). */
function arguments_(source: string, command: string): string[] {
  const found: string[] = [];
  let at = source.indexOf(command);
  while (at >= 0) {
    let i = at + command.length;
    if (!/[A-Za-z@]/.test(source[i] ?? "")) {
      while (/\s/.test(source[i] ?? "")) i++;
      if (source[i] === "[") {
        const close = source.indexOf("]", i);
        i = close < 0 ? source.length : close + 1;
        while (/\s/.test(source[i] ?? "")) i++;
      }
      if (source[i] === "{") {
        const close = source.indexOf("}", i);
        if (close > i) found.push(source.slice(i + 1, close));
      }
    }
    at = source.indexOf(command, at + command.length);
  }
  return found;
}
const names = (source: string, command: string) =>
  arguments_(source, command).flatMap((list) => list.split(",").map((name) => name.trim()));
const hasCjk = (source: string) =>
  [...source].some((c) => {
    const code = c.codePointAt(0) ?? 0;
    return (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff)
    );
  });
/** 3 LuaLaTeX, 2 XeLaTeX for its packages, 1 XeLaTeX for CJK text, 0 anything. */
export function engineNeed(text: string): number {
  const source = withoutComments(text);
  const packages = [...names(source, "\\usepackage"), ...names(source, "\\RequirePackage")];
  const classes = names(source, "\\documentclass");
  if (packages.some((p) => p.startsWith("luatexja")) || classes.some((c) => c.startsWith("ltj")))
    return 3;
  if (packages.some((p) => XE_PACKAGES.includes(p)) || classes.some((c) => XE_CLASSES.includes(c)))
    return 2;
  return hasCjk(source) ? 1 : 0;
}
/** `a/./b/../c` → `a/c`; null when it leaves the project. */
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}
/**
 * The engine for building `main`, given a reader of project files by path (from the project
 * root) and the directory LaTeX runs in, which `\input` paths are relative to.
 */
export function texEngine(
  read: (path: string) => string | null | undefined,
  main: string,
  base = "",
): TexEngine {
  return magicEngine(read(main) ?? "") ?? neededEngine(read, main, base);
}
/** What the sources ask for, without the magic comment (which may name latexmk). */
export function neededEngine(
  read: (path: string) => string | null | undefined,
  main: string,
  base = "",
): "pdflatex" | "xelatex" | "lualatex" {
  let need = 0;
  const pending = [main],
    visited = new Set<string>();
  while (pending.length && visited.size < MAX_FILES) {
    const path = pending.pop() as string;
    if (visited.has(path)) continue;
    const content = read(path);
    if (content === null || content === undefined) continue;
    visited.add(path);
    need = Math.max(need, engineNeed(content));
    const source = withoutComments(content);
    for (const name of [...arguments_(source, "\\input"), ...arguments_(source, "\\include")]) {
      const file = name.trim();
      for (const candidate of file.endsWith(".tex") ? [file] : [`${file}.tex`, file]) {
        const resolved = normalize(base ? `${base}/${candidate}` : candidate);
        if (resolved) pending.push(resolved);
      }
    }
  }
  return need === 3 ? "lualatex" : need ? "xelatex" : "pdflatex";
}
