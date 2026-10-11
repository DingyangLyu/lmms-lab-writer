import { hunks } from "./merge";
export type ReviewHunk = {
  id: string;
  from: number;
  to: number;
  before: string;
  after: string;
  status: "pending" | "accepted" | "rejected";
};
/** A text's lines, each with its newline (the last may have none). */
export const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+/g) ?? [];
/**
 * The changes from `before` to `after` as hunks to accept or reject one by one: the shared
 * diff (merge.ts `hunks`) over lines, as the desktop's reviews (reviews.rs `parts`) split
 * them, so one AI edit is reviewed in the same pieces on either side.
 */
export function reviewHunks(before: string, after: string): ReviewHunk[] {
  const a = lines(before),
    b = lines(after);
  const at = [0];
  for (const line of b) at.push((at.at(-1) ?? 0) + line.length);
  return hunks(a, b).map(([aStart, aEnd, bStart, bEnd], i) => ({
    id: String(i),
    from: at[bStart] ?? 0,
    to: at[bEnd] ?? 0,
    before: a.slice(aStart, aEnd).join(""),
    after: b.slice(bStart, bEnd).join(""),
    status: "pending",
  }));
}
/** Original after-version is immutable; decisions create a new desired version. */
export function reviewedText(after: string, hunks: ReviewHunk[]) {
  let output = after;
  for (const hunk of [...hunks].reverse()) {
    if (after.slice(hunk.from, hunk.to) !== hunk.after) throw new Error("审阅版本不匹配");
    if (hunk.status === "rejected")
      output = output.slice(0, hunk.from) + hunk.before + output.slice(hunk.to);
  }
  return output;
}
