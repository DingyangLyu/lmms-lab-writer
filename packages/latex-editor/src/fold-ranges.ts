/** One-based line numbers, as used by CodeMirror lines and Monaco folding ranges. */
export type LaTeXFoldingRange = {
  start: number;
  end: number;
  kind?: "comment";
};

type Environment = { name: string; start: number };
type Heading = { level: number; start: number };

const headingLevels: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

// Commands inside these environments are literal text rather than LaTeX syntax.
const opaqueEnvironments = new Set(["verbatim", "Verbatim", "lstlisting", "minted", "comment"]);

const commandPattern =
  /\\(begin|end)\s*\{\s*([A-Za-z][A-Za-z0-9*@_-]*)\s*\}|\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\s*\[[^\]]*\])?\s*\{|\\verb\*?([^\sA-Za-z])/g;
const opaqueEndPattern = /\\end\s*\{\s*([A-Za-z][A-Za-z0-9*@_-]*)\s*\}/g;

function isEscaped(line: string, position: number): boolean {
  let backslashes = 0;
  for (let index = position - 1; index >= 0 && line[index] === "\\"; index--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function findComment(line: string, from: number): number {
  for (let index = from; index < line.length; index++) {
    if (line[index] === "%" && !isEscaped(line, index)) return index;
  }
  return -1;
}

function findCommand(line: string, from: number): RegExpExecArray | null {
  commandPattern.lastIndex = from;
  for (let match = commandPattern.exec(line); match; match = commandPattern.exec(line)) {
    if (!isEscaped(line, match.index)) return match;
  }
  return null;
}

function findOpaqueEnd(line: string, from: number, name: string): RegExpExecArray | null {
  opaqueEndPattern.lastIndex = from;
  for (let match = opaqueEndPattern.exec(line); match; match = opaqueEndPattern.exec(line)) {
    if (match[1] === name && !isEscaped(line, match.index)) return match;
  }
  return null;
}

/**
 * Finds foldable LaTeX sections, environments, and consecutive full-line comments.
 * Incomplete constructs are ignored instead of hiding unrelated text while editing.
 */
export function getLaTeXFoldingRanges(source: string): LaTeXFoldingRange[] {
  const lines = source.split(/\r\n|\r|\n/);
  const candidates: LaTeXFoldingRange[] = [];
  const environments: Environment[] = [];
  const headings: Heading[] = [];
  let opaqueName: string | undefined;
  let commentStart: number | undefined;

  const addRange = (start: number, end: number, kind?: "comment") => {
    if (end > start) candidates.push(kind ? { start, end, kind } : { start, end });
  };

  const closeComments = (end: number) => {
    if (commentStart !== undefined) {
      addRange(commentStart, end, "comment");
      commentStart = undefined;
    }
  };

  const closeHeadings = (minimumLevel: number, end: number) => {
    while (headings.length > 0 && (headings.at(-1)?.level ?? -1) >= minimumLevel) {
      const heading = headings.pop();
      if (heading) addRange(heading.start, end);
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const lineNumber = lineIndex + 1;
    let cursor = 0;
    let fullLineComment = false;

    while (cursor < line.length) {
      if (opaqueName) {
        const closing = findOpaqueEnd(line, cursor, opaqueName);
        if (!closing) break;
        const environment = environments.at(-1);
        if (environment?.name === opaqueName) {
          environments.pop();
          addRange(environment.start, lineNumber);
        }
        opaqueName = undefined;
        cursor = closing.index + closing[0].length;
        continue;
      }

      const commentIndex = findComment(line, cursor);
      const command = findCommand(line, cursor);
      if (commentIndex !== -1 && (!command || commentIndex < command.index)) {
        fullLineComment = line.slice(0, commentIndex).trim().length === 0;
        break;
      }
      if (!command) break;

      cursor = command.index + command[0].length;
      if (command[4]) {
        // Inline \verb|...| can contain apparent section and environment commands.
        const delimiter = command[4];
        const closing = line.indexOf(delimiter, cursor);
        cursor = closing === -1 ? line.length : closing + 1;
        continue;
      }

      if (command[3]) {
        // A heading inside a figure, table, or another environment is not a
        // document section. The document environment itself is transparent.
        if (environments.some(({ name }) => name !== "document")) continue;
        const level = headingLevels[command[3]];
        if (level !== undefined) {
          closeHeadings(level, lineNumber - 1);
          headings.push({ level, start: lineNumber });
        }
        continue;
      }

      const name = command[2];
      if (!name) continue;
      if (command[1] === "begin") {
        environments.push({ name, start: lineNumber });
        if (opaqueEnvironments.has(name)) opaqueName = name;
      } else if (environments.at(-1)?.name === name) {
        const environment = environments.pop();
        if (environment) addRange(environment.start, lineNumber);
        if (name === "document") closeHeadings(0, lineNumber - 1);
      }
    }

    if (fullLineComment) {
      commentStart ??= lineNumber;
    } else {
      closeComments(lineNumber - 1);
    }
  }

  closeComments(lines.length);
  // A trailing newline creates an empty Monaco line; do not fold into it.
  let lastContentLine = lines.length;
  while (lastContentLine > 0 && !lines[lastContentLine - 1]?.trim()) lastContentLine--;
  closeHeadings(0, lastContentLine);

  // Monaco expects ranges to be nested or disjoint. Malformed LaTeX can
  // otherwise create crossing section/environment ranges during editing.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const ranges: LaTeXFoldingRange[] = [];
  const active: LaTeXFoldingRange[] = [];
  for (const candidate of candidates) {
    while (active.length > 0 && (active.at(-1)?.end ?? 0) < candidate.start) active.pop();
    if (ranges.at(-1)?.start === candidate.start) continue;
    if (active.length > 0 && candidate.end > (active.at(-1)?.end ?? 0)) continue;
    ranges.push(candidate);
    active.push(candidate);
  }
  return ranges;
}
