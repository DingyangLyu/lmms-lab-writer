/** Which project paths the collaboration server accepts, and which it stores as live text. */

/** Text files become shared documents; everything else is stored as a binary file. */
export const textExtensions = new Set([
  "tex",
  "bib",
  "md",
  "txt",
  "sty",
  "cls",
  "bst",
  "csv",
  "json",
  "py",
  "yml",
  "yaml",
]);
export const isTextPath = (path: string) =>
  textExtensions.has(path.split(".").pop()?.toLowerCase() ?? "");

/** Relative, "/"-separated, no hidden segments, no drive letters or control characters. */
export function validPath(path: string) {
  return (
    !!path &&
    path.length <= 240 &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => !part || part.startsWith(".")) &&
    !path.includes(":") &&
    ![...path].some((c) => c.charCodeAt(0) < 32)
  );
}

/** Copies the sync keeps when both sides changed a file; they stay local. */
const CONFLICT = /\.conflict-\d{8}-\d{6}(\.[^./]+)?$/;
export const isConflictCopy = (path: string) => CONFLICT.test(path);
export function conflictCopyPath(path: string, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slash = path.lastIndexOf("/"),
    dot = path.lastIndexOf(".");
  return dot > slash + 1
    ? `${path.slice(0, dot)}.conflict-${stamp}${path.slice(dot)}`
    : `${path}.conflict-${stamp}`;
}
