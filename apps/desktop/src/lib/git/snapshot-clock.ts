export const SNAPSHOT_INTERVAL = 15 * 60 * 1000;
export type SnapshotClock = { head: string | null; snapshot: string | null; due: number };
export type GitVersion = { head: string | null; snapshot: string | null };
export function observeGit(
  clock: SnapshotClock | null,
  version: GitVersion,
  now: number,
): SnapshotClock {
  if (
    !clock ||
    !Number.isFinite(clock.due) ||
    clock.head !== version.head ||
    clock.snapshot !== version.snapshot
  )
    return { ...version, due: now + SNAPSHOT_INTERVAL };
  return clock;
}
export function afterGitCheck(version: GitVersion, now: number): SnapshotClock {
  return { ...version, due: now + SNAPSHOT_INTERVAL };
}
