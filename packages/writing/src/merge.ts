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
/** ASCII words and TeX commands stay whole; every other character (CJK too) is a token. */
const tokens = (s: string) => s.match(/[\\\w]+|[^\\\w]/gu) || [];
/** A changed span: tokens `a[aStart, aEnd)` became `b[bStart, bEnd)`. */
export type Hunk = [aStart: number, aEnd: number, bStart: number, bEnd: number];
/**
 * Steps the diff may take before it settles for one change covering everything between the
 * common prefix and suffix. A step count rather than a clock, so that every machine, and the
 * desktop's Rust copy, reach the same answer.
 */
const BUDGET = 4_000_000;
/**
 * The changes from `a` to `b`: Myers' greedy shortest edit script after trimming the common
 * prefix and suffix. The desktop has the same algorithm, step for step, in Rust
 * (apps/desktop/src-tauri/src/commands/document_merge.rs `hunks`), so a merge the editor
 * makes and one its backend makes agree; change both together.
 */
export function hunks<T>(a: readonly T[], b: readonly T[]): Hunk[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const n = a.length - p - s,
    m = b.length - p - s;
  if (!n && !m) return [];
  const whole: Hunk[] = [[p, p + n, p, p + m]];
  if (!n || !m) return whole;
  // v[k + max + 1]: furthest x reached on diagonal k; trace[d]: v over -d..d after step d.
  const max = n + m,
    o = max + 1,
    v = new Int32Array(2 * max + 3),
    trace: Int32Array[] = [];
  let work = 0;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[o + k - 1] ?? 0) < (v[o + k + 1] ?? 0));
      let x = down ? (v[o + k + 1] ?? 0) : (v[o + k - 1] ?? 0) + 1,
        y = x - k;
      while (x < n && y < m && a[p + x] === b[p + y]) {
        x++;
        y++;
        work++;
      }
      v[o + k] = x;
      if (++work > BUDGET) return whole;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, p);
    }
    trace.push(v.slice(o - d, o + d + 1));
  }
  return whole;
}
/** Walks the script back from the end, one insertion or deletion per step, into hunks. */
function backtrack(trace: Int32Array[], last: number, n: number, m: number, p: number): Hunk[] {
  const steps: Hunk[] = [];
  let x = n,
    y = m;
  for (let d = last; d > 0; d--) {
    const before = trace[d - 1] as Int32Array,
      at = (k: number) => before[k + d - 1] ?? 0,
      k = x - y,
      down = k === -d || (k !== d && at(k - 1) < at(k + 1)),
      px = at(down ? k + 1 : k - 1),
      py = px - (down ? k + 1 : k - 1);
    steps.push(down ? [px, px, py, py + 1] : [px, px + 1, py, py]);
    x = px;
    y = py;
  }
  const out: Hunk[] = [];
  for (const [aStart, aEnd, bStart, bEnd] of steps.reverse()) {
    const previous = out.at(-1);
    if (previous && previous[1] === p + aStart && previous[3] === p + bStart) {
      previous[1] = p + aEnd;
      previous[3] = p + bEnd;
    } else out.push([p + aStart, p + aEnd, p + bStart, p + bEnd]);
  }
  return out;
}
type Edit = { start: number; end: number; text: string; side: number };
function edits(base: string, next: string, side: number): Edit[] {
  const a = tokens(base),
    b = tokens(next);
  // Where each token of `base` starts, and the end.
  const at = [0];
  for (const token of a) at.push((at.at(-1) ?? 0) + token.length);
  return hunks(a, b).map(([aStart, aEnd, bStart, bEnd]) => ({
    start: at[aStart] ?? 0,
    end: at[aEnd] ?? 0,
    text: b.slice(bStart, bEnd).join(""),
    side,
  }));
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
