import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyTextChange, fromBase64, toBase64 } from "./engine";
import { conflictCopyPath, isConflictCopy, isTextPath, validPath } from "./paths";

describe("applyTextChange", () => {
  it("keeps a concurrent edit that a whole-text replacement would have overwritten", () => {
    const base = new Y.Doc();
    base.getText("content").insert(0, "intro\nmethods\nresults\n");
    const remote = new Y.Doc(),
      local = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(local, Y.encodeStateAsUpdate(base));
    remote.getText("content").insert(13, " (revised)");
    const text = local.getText("content");
    local.transact(() => applyTextChange(text, text.toString(), "Intro\nmethods\nResults\n"));
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
    expect(local.getText("content").toString()).toBe("Intro\nmethods (revised)\nResults\n");
  });

  it("handles emoji and Chinese as JavaScript strings do", () => {
    const doc = new Y.Doc(),
      text = doc.getText("content");
    text.insert(0, "结论 👍 good");
    applyTextChange(text, text.toString(), "结论 👍👍 很好");
    expect(text.toString()).toBe("结论 👍👍 很好");
  });
});

describe("paths", () => {
  it("matches the server's rules", () => {
    expect(isTextPath("paper/Main.TEX")).toBe(true);
    expect(isTextPath("fig.png")).toBe(false);
    expect(validPath("sec/intro.tex")).toBe(true);
    for (const bad of [".latexmkrc", "a/.hidden/x.tex", "/abs.tex", "c:x.tex", "a\\b.tex", ""])
      expect(validPath(bad)).toBe(false);
  });

  it("names conflict copies so they keep their type and stay local", () => {
    const copy = conflictCopyPath("ch/intro.tex", new Date("2026-10-08T14:32:05Z"));
    expect(copy).toBe("ch/intro.conflict-20261008-143205.tex");
    expect(isConflictCopy(copy)).toBe(true);
    expect(isConflictCopy(conflictCopyPath("Makefile"))).toBe(true);
    expect(isConflictCopy("ch/intro.tex")).toBe(false);
  });

  it("round-trips base64 for large binaries", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
