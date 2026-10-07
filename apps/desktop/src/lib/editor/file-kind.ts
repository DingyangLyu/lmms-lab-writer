/** How the editor shows a project file, decided by its name alone. */
export type FileKind = "text" | "image" | "pdf" | "binary";

const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"]);
const BINARY = new Set([
  ...["ppt", "pptx", "pps", "ppsx", "potx", "doc", "docx", "xls", "xlsx"],
  ...["odt", "odp", "ods", "key", "numbers", "pages"],
  ...["exe", "dmg", "mp3", "mp4", "mov"],
  ...["zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar"],
  ...["dvi", "ttf", "otf", "woff", "woff2", "eot", "ds_store"],
]);
const LANGUAGE: Record<string, string> = {
  tex: "latex",
  sty: "latex",
  cls: "latex",
  bib: "bibtex",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  md: "markdown",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  java: "java",
  rs: "rust",
  go: "go",
  rb: "ruby",
  php: "php",
  sql: "sql",
  r: "r",
  lua: "lua",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

/** The text after the last dot, or the whole name (e.g. `makefile`) when there is none. */
const extension = (path: string) =>
  (path.split(/[\\/]/).pop() ?? "").split(".").pop()?.toLowerCase() ?? "";

export function fileKind(path: string): FileKind {
  const ext = extension(path);
  if (IMAGE.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (BINARY.has(ext) || path.toLowerCase().endsWith(".synctex.gz")) return "binary";
  return "text";
}

export function fileLanguage(path: string): string {
  return LANGUAGE[extension(path)] ?? "plaintext";
}
