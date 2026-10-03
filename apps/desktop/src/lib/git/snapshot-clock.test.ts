import { describe, expect, it } from "vitest";
import { afterGitCheck, observeGit, SNAPSHOT_INTERVAL } from "./snapshot-clock";

describe("Git autosave scheduling", () => {
  it("waits 15 minutes, including across repeated polls and restart", () => {
    const version = { head: "a", snapshot: null };
    const first = observeGit(null, version, 1000);
    expect(first.due).toBe(1000 + SNAPSHOT_INTERVAL);
    expect(observeGit(JSON.parse(JSON.stringify(first)), version, 5000).due).toBe(first.due);
  });
  it("defers after either manual branch commits or snapshot saves", () => {
    const initial = observeGit(null, { head: "a", snapshot: "s1" }, 0);
    const manual = observeGit(initial, { head: "b", snapshot: "s1" }, 600000);
    expect(manual.due).toBe(1500000);
    const snapshot = observeGit(manual, { head: "b", snapshot: "s2" }, 700000);
    expect(snapshot.due).toBe(1600000);
    expect(afterGitCheck(snapshot, 1600000).due).toBe(2500000);
  });
});
