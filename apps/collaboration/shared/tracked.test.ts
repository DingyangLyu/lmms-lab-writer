import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type ChangeAuthor,
  changesOf,
  decideChanges,
  editsFromOperations,
  resolveChanges,
  trackEdits,
} from "./tracked";

const ana: ChangeAuthor = { author: "ana", name: "Ana" },
  bo: ChangeAuthor = { author: "bo", name: "Bo" };

function start(content: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  return doc;
}
/** One tracked edit, as the editor makes it: [from, to) replaced by `insert`. */
function edit(
  doc: Y.Doc,
  who: ChangeAuthor,
  from: number,
  to: number,
  insert = "",
  origin?: unknown,
) {
  const text = doc.getText("content");
  const before = resolveChanges(doc).changes,
    deleted = text.toString().slice(from, to);
  doc.transact(() => {
    if (to > from) text.delete(from, to - from);
    if (insert) text.insert(from, insert);
    trackEdits(
      doc,
      before,
      [{ fromA: from, toA: to, fromB: from, toB: from + insert.length, deleted }],
      who,
    );
  }, origin);
}
const type = (doc: Y.Doc, who: ChangeAuthor, at: number, word: string) => {
  for (const [i, ch] of [...word].entries()) edit(doc, who, at + i, at + i, ch);
};
/** The text with insertions as {+…+} and deletions as [-…-]. */
function show(doc: Y.Doc) {
  const text = doc.getText("content").toString();
  let out = "",
    at = 0;
  for (const c of resolveChanges(doc).changes) {
    out += text.slice(at, c.from);
    out += c.kind === "insert" ? `{+${text.slice(c.from, c.to)}+}` : `[-${c.text}-]`;
    at = c.kind === "insert" ? c.to : c.from;
  }
  return out + text.slice(at);
}

describe("tracked changes", () => {
  it("keeps typing as one insertion, and deletions out of the text", () => {
    const doc = start("Hello world");
    type(doc, ana, 5, " big");
    expect(show(doc)).toBe("Hello{+ big+} world");
    expect(changesOf(doc).size).toBe(1);
    expect(doc.getText("content").toString()).toBe("Hello big world");
  });

  it("merges repeated Backspace and Delete into one deletion, in reading order", () => {
    const back = start("Hello world");
    for (let end = 11; end > 6; end--) edit(back, ana, end - 1, end);
    expect(show(back)).toBe("Hello [-world-]");
    expect(back.getText("content").toString()).toBe("Hello ");
    const forward = start("Hello world!");
    for (let i = 0; i < 5; i++) edit(forward, ana, 6, 7);
    expect(show(forward)).toBe("Hello [-world-]!");
    expect(changesOf(forward).size).toBe(1);
  });

  it("shows a replaced word struck through, then the new one", () => {
    const doc = start("Hello world");
    edit(doc, ana, 6, 11, "t");
    type(doc, ana, 7, "here");
    expect(show(doc)).toBe("Hello [-world-]{+there+}");
  });

  it("removes characters of an insertion without recording them, and forgets an emptied one", () => {
    const doc = start("ab");
    type(doc, ana, 1, "XYZ");
    edit(doc, bo, 2, 3);
    expect(show(doc)).toBe("a{+XZ+}b");
    edit(doc, ana, 1, 3);
    expect(show(doc)).toBe("ab");
    expect(changesOf(doc).size).toBe(0);
  });

  it("deletes across original text and an insertion: only the original is kept", () => {
    const doc = start("one two");
    type(doc, ana, 3, "NEW");
    // "oneNEW two": delete "eNEW t".
    edit(doc, ana, 2, 8);
    expect(show(doc)).toBe("on[-e t-]wo");
  });

  it("keeps different authors apart", () => {
    const doc = start("ab");
    type(doc, ana, 1, "x");
    type(doc, bo, 2, "y");
    expect(resolveChanges(doc).changes.map((c) => [c.name, c.from, c.to])).toEqual([
      ["Ana", 1, 2],
      ["Bo", 2, 3],
    ]);
  });

  it("accepts and rejects", () => {
    const doc = start("Hello world");
    edit(doc, ana, 6, 11, "there");
    type(doc, ana, 0, ">> ");
    const [quote, deletion, insertion] = resolveChanges(doc).changes;
    if (!quote || !deletion || !insertion) throw new Error("three changes expected");
    doc.transact(() => decideChanges(doc, [quote.id], true));
    expect(show(doc)).toBe(">> Hello [-world-]{+there+}");
    doc.transact(() => decideChanges(doc, [deletion.id, insertion.id], false));
    expect(show(doc)).toBe(">> Hello world");
    expect(changesOf(doc).size).toBe(0);
  });

  it("follows edits made concurrently elsewhere", () => {
    const a = start("The cat sat."),
      b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    edit(a, ana, 4, 7, "dog");
    b.getText("content").insert(0, "Yesterday ");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(show(a)).toBe("Yesterday The [-cat-]{+dog+} sat.");
    expect(show(b)).toBe(show(a));
  });

  it("is undone together with the edit", () => {
    const doc = start("Hello world");
    const origin = {};
    const undo = new Y.UndoManager([doc.getText("content"), changesOf(doc)], {
      trackedOrigins: new Set([origin]),
    });
    edit(doc, ana, 6, 11, "", origin);
    expect(show(doc)).toBe("Hello [-world-]");
    undo.undo();
    expect(show(doc)).toBe("Hello world");
    expect(changesOf(doc).size).toBe(0);
  });

  it("records the server's diff operations, as an AI's edits arrive", () => {
    const before = "alpha beta gamma";
    const doc = start(before);
    const operations = [
      { at: 0, remove: 5, insert: "ALPHA" },
      { at: 11, remove: 0, insert: "and " },
    ];
    const resolved = resolveChanges(doc).changes;
    doc.transact(() => {
      const text = doc.getText("content");
      for (const op of [...operations].reverse()) {
        text.delete(op.at, op.remove);
        text.insert(op.at, op.insert);
      }
      trackEdits(doc, resolved, editsFromOperations(before, operations), {
        author: "ana",
        name: "Codex · Ana",
      });
    });
    expect(show(doc)).toBe("[-alpha-]{+ALPHA+} beta {+and +}gamma");
  });

  it("reports changes whose text is gone as lost", () => {
    const doc = start("ab");
    type(doc, ana, 1, "xyz");
    doc.getText("content").delete(1, 3);
    expect(resolveChanges(doc)).toMatchObject({ changes: [], lost: [expect.any(String)] });
  });
});
