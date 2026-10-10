/**
 * Word count as Overleaf gives it (texcount's measures): words in the text, headings and
 * captions counted apart, inline and displayed formulas, with \input and \include followed.
 * Chinese, Japanese and Korean characters count one each, as words do not apply to them.
 */
export type WordCount = {
  /** Words in the running text (not headings or captions). */
  words: number;
  /** CJK characters in the running text. */
  characters: number;
  headers: number;
  headerWords: number;
  captions: number;
  captionWords: number;
  inlineMath: number;
  displayMath: number;
  /** The files counted, the main one first. */
  files: string[];
};

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const HEADERS = new Set([
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
]);
/** Commands whose arguments are not prose (references, files, layout): dropped with them. */
const DROP = new Set([
  "cite",
  "citep",
  "citet",
  "citeauthor",
  "citeyear",
  "parencite",
  "textcite",
  "autocite",
  "nocite",
  "ref",
  "eqref",
  "autoref",
  "cref",
  "Cref",
  "pageref",
  "label",
  "usepackage",
  "RequirePackage",
  "documentclass",
  "input",
  "include",
  "subfile",
  "includegraphics",
  "bibliography",
  "bibliographystyle",
  "addbibresource",
  "url",
  "begin",
  "end",
  "newcommand",
  "renewcommand",
  "providecommand",
  "newenvironment",
  "setlength",
  "addtolength",
  "vspace",
  "hspace",
  "color",
  "pagestyle",
  "thispagestyle",
  "setcounter",
  "graphicspath",
]);
/** The first argument is not prose, the rest is (a link's address, a colour). */
const DROP_FIRST = new Set(["href", "textcolor", "colorbox"]);

const count = (text: string) => ({
  characters: (text.match(CJK) ?? []).length,
  words: (text.replace(CJK, " ").match(WORD) ?? []).length,
});

/** Text without comments: `%` to the end of the line, unless escaped. */
export function stripComments(text: string) {
  return text.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, "$1$2");
}

/** The end of a `{…}` group starting at `open` (exclusive), or -1. */
function group(text: string, open: number) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}
/** Optional `[…]` arguments and spaces after a command. */
function skipOptional(text: string, at: number) {
  let i = at;
  for (;;) {
    while (text[i] === " " || text[i] === "*") i++;
    if (text[i] !== "[") return i;
    const close = text.indexOf("]", i);
    if (close < 0) return i;
    i = close + 1;
  }
}

/** The text with every \input, \include and \subfile replaced by that file. */
export function expand(
  path: string,
  read: (path: string) => string | null,
  seen: Set<string> = new Set(),
): string {
  if (seen.has(path) || seen.size > 200) return "";
  const own = read(path);
  if (own === null) return "";
  seen.add(path);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  return stripComments(own).replace(
    /\\(?:input|include|subfile)\s*\{([^}]+)\}/g,
    (_all, name: string) => {
      const file = name.trim().endsWith(".tex") ? name.trim() : `${name.trim()}.tex`;
      const found = [file, `${dir}${file}`].find((p) => read(p) !== null);
      return found ? `\n${expand(found, read, seen)}\n` : " ";
    },
  );
}

export function wordCount(main: string, read: (path: string) => string | null): WordCount {
  const files = new Set<string>();
  let text = expand(main, (p) => {
    const content = read(p);
    if (content !== null) files.add(p);
    return content;
  });
  const result: WordCount = {
    words: 0,
    characters: 0,
    headers: 0,
    headerWords: 0,
    captions: 0,
    captionWords: 0,
    inlineMath: 0,
    displayMath: 0,
    files: [...files],
  };
  // The document's body only, without its bibliography.
  const begin = text.indexOf("\\begin{document}");
  if (begin >= 0) {
    const end = text.indexOf("\\end{document}", begin);
    text = text.slice(begin + 16, end < 0 ? undefined : end);
  }
  text = text
    .replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/g, " ")
    .replace(/\\printbibliography(\[[^\]]*\])?/g, " ");
  // Displayed formulas, then inline ones.
  const display = (pattern: RegExp) => {
    text = text.replace(pattern, () => {
      result.displayMath++;
      return " ";
    });
  };
  display(
    /\\begin\{(equation|align|gather|multline|eqnarray|displaymath|flalign|alignat)(\*?)\}[\s\S]*?\\end\{\1\2\}/g,
  );
  display(/\\\[[\s\S]*?\\\]/g);
  display(/\$\$[\s\S]*?\$\$/g);
  text = text.replace(/\\\([\s\S]*?\\\)|(?<!\\)\$(?:\\.|[^$\\])+\$/g, () => {
    result.inlineMath++;
    return " ";
  });
  // Commands: headings and captions counted apart, references and layout dropped.
  let out = "";
  let last = 0;
  const command = /\\([A-Za-z@]+)\*?/g;
  for (let found = command.exec(text); found; found = command.exec(text)) {
    const name = found[1] ?? "";
    out += text.slice(last, found.index);
    last = command.lastIndex;
    const heading = HEADERS.has(name),
      caption = name === "caption";
    if (heading || caption || DROP.has(name) || DROP_FIRST.has(name)) {
      let at = skipOptional(text, last);
      if (text[at] !== "{") continue;
      const close = group(text, at);
      if (close < 0) continue;
      const inner = text.slice(at + 1, close - 1);
      if (heading || caption) {
        const words = count(stripMarkup(inner));
        if (heading) {
          result.headers++;
          result.headerWords += words.words + words.characters;
        } else {
          result.captions++;
          result.captionWords += words.words + words.characters;
        }
      }
      at = close;
      // \begin{figure}[htbp] and the like.
      if (name === "begin") at = skipOptional(text, at);
      last = at;
      command.lastIndex = at;
    }
  }
  out += text.slice(last);
  const body = count(stripMarkup(out));
  result.words = body.words;
  result.characters = body.characters;
  return result;
}

/** What is left once commands, braces and escapes are gone. */
function stripMarkup(text: string) {
  return text
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/\\[^A-Za-z@]/g, " ")
    .replace(/[{}[\]~&^_#]/g, " ");
}
