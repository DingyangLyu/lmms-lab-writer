import { diffLines } from "diff";
export type ReviewHunk = {
  id: string;
  from: number;
  to: number;
  before: string;
  after: string;
  status: "pending" | "accepted" | "rejected";
};
export function reviewHunks(before: string, after: string): ReviewHunk[] {
  const parts = diffLines(before, after, { timeout: 600 });
  if (!parts) throw new Error("文件差异计算超时，请拆分修改。");
  const hunks: ReviewHunk[] = [];
  let offset = 0,
    pending: ReviewHunk | null = null;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (pending) {
        hunks.push(pending);
        pending = null;
      }
      offset += part.value.length;
    } else {
      pending ??= {
        id: String(hunks.length),
        from: offset,
        to: offset,
        before: "",
        after: "",
        status: "pending",
      };
      if (part.removed) pending.before += part.value;
      else {
        pending.after += part.value;
        offset += part.value.length;
        pending.to = offset;
      }
    }
  }
  if (pending) hunks.push(pending);
  return hunks;
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
