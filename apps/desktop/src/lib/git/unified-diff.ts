/** Original and modified text reconstructed from a unified diff, for side-by-side display. */
export type ParsedUnifiedDiff = {
  original: string;
  modified: string;
  added: number;
  removed: number;
  hasRenderableHunks: boolean;
  isBinary: boolean;
};

export function parseUnifiedDiffContent(content: string): ParsedUnifiedDiff {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let inHunk = false,
    added = 0,
    removed = 0,
    isBinary = false;
  for (const line of lines) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) isBinary = true;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line === "\\ No newline at end of file") continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      modifiedLines.push(line.slice(1));
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      originalLines.push(line.slice(1));
      removed += 1;
    } else if (line.startsWith(" ")) {
      originalLines.push(line.slice(1));
      modifiedLines.push(line.slice(1));
    } else if (line.length === 0) {
      originalLines.push("");
      modifiedLines.push("");
    }
  }
  return {
    original: originalLines.join("\n"),
    modified: modifiedLines.join("\n"),
    added,
    removed,
    hasRenderableHunks: originalLines.length > 0 || modifiedLines.length > 0,
    isBinary,
  };
}
