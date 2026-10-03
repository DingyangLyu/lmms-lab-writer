import { diffArrays } from "diff";
export type MergePart = {
  text: string | null;
  base: string | null;
  ours: string | null;
  theirs: string | null;
};
export type DocumentConflict = {
  id: string;
  revision?: string;
  path: string;
  owner: string;
  annotationId?: string | null;
  base: string;
  ours: string;
  theirs: string;
  disk: string;
  parts: MergePart[];
  updatedAt: number;
  status: string;
  local?: boolean;
};
export type SaveResult = {
  status: "saved" | "conflict" | "reviewed";
  content: string;
  merged: boolean;
  conflict?: DocumentConflict | null;
  versionError?: string | null;
};
const tokens = (s: string) => s.match(/[\\\w]+|[^\\\w]/gu) || [];
type Edit = { start: number; end: number; text: string; side: number };
function edits(base: string, next: string, side: number): Edit[] {
  const a = tokens(base),
    b = tokens(next);
  const changes = diffArrays(a, b, { timeout: 300 });
  if (!changes) return [{ start: 0, end: base.length, text: next, side }];
  let offset = 0;
  const out: Edit[] = [];
  let pending: Edit | undefined;
  for (const change of changes) {
    const text = change.value.join("");
    if (change.added || change.removed) {
      pending ??= { start: offset, end: offset, text: "", side };
      if (change.added) pending.text += text;
      else {
        offset += text.length;
        pending.end = offset;
      }
    } else {
      if (pending) {
        out.push(pending);
        pending = undefined;
      }
      offset += text.length;
    }
  }
  if (pending) out.push(pending);
  return out;
}
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
): { content: string | null; parts: MergePart[] } {
  const plain = (text: string): MergePart => ({ text, base: null, ours: null, theirs: null });
  if (ours === theirs || theirs === base) return { content: ours, parts: [plain(ours)] };
  if (ours === base) return { content: theirs, parts: [plain(theirs)] };
  const all = [...edits(base, ours, 0), ...edits(base, theirs, 1)].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.side - b.side,
  );
  const parts: MergePart[] = [];
  let cursor = 0,
    i = 0;
  while (i < all.length) {
    const first = all[i];
    if (!first) break;
    const start = first.start;
    let end = first.end,
      j = i + 1;
    while (j < all.length) {
      const e = all[j];
      if (!e || !(e.start < end || (start === end && e.start === start && e.end === start))) break;
      end = Math.max(end, e.end);
      j++;
    }
    if (cursor < start) parts.push(plain(base.slice(cursor, start)));
    const apply = (side: number) => {
      let out = "",
        p = start;
      for (const e of all.slice(i, j).filter((e) => e.side === side)) {
        out += base.slice(p, e.start) + e.text;
        p = e.end;
      }
      return out + base.slice(p, end);
    };
    const left = apply(0),
      right = apply(1),
      old = base.slice(start, end);
    if (left === right || right === old) parts.push(plain(left));
    else if (left === old) parts.push(plain(right));
    else parts.push({ text: null, base: old, ours: left, theirs: right });
    cursor = end;
    i = j;
  }
  if (cursor < base.length) parts.push(plain(base.slice(cursor)));
  return {
    content: parts.some((p) => p.text === null) ? null : parts.map((p) => p.text).join(""),
    parts,
  };
}

export const documentEdits = (base: string, next: string) =>
  edits(base, next, 0).map((e) => ({ from: e.start, to: e.end, insert: e.text }));
