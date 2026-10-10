/**
 * Where a member left off in each file: the first line on screen and the cursor, kept in memory
 * for switching between files and in this browser's storage for the next visit. Lines rather
 * than offsets, so a collaborator's edits elsewhere move it as little as possible.
 */
export type FilePosition = { top: number; line: number; ch: number };
const memory = new Map<string, FilePosition>();
const key = (project: string, file: string) => `writer-position:${project}:${file}`;

export function readPosition(project: string, file: string): FilePosition | null {
  const k = key(project, file);
  const cached = memory.get(k);
  if (cached) return cached;
  try {
    const saved = JSON.parse(localStorage.getItem(k) || "null") as FilePosition | null;
    if (saved && [saved.top, saved.line, saved.ch].every((n) => Number.isInteger(n) && n >= 0)) {
      memory.set(k, saved);
      return saved;
    }
  } catch {
    /* Storage may be unavailable or hold something else. */
  }
  return null;
}

export function writePosition(project: string, file: string, position: FilePosition) {
  const k = key(project, file);
  memory.set(k, position);
  try {
    localStorage.setItem(k, JSON.stringify(position));
  } catch {
    /* Remembered for this visit only. */
  }
}
