/**
 * Track changes, as on Overleaf. While it is on, what someone types is kept as an insertion and
 * what they delete as a deletion: the deleted text leaves the document (builds show the new
 * version) but is kept beside it, to be put back if the deletion is rejected. Each change waits
 * for someone to accept or reject it.
 *
 * Changes live in each file's Yjs document, in the map `changes` beside the text `content`,
 * anchored by Yjs relative positions: they follow concurrent edits, sync and persist with the
 * text, and undo takes back an edit and its change together. Browsers record their members'
 * edits (src/tracked-changes.ts); the server records an AI's (Collaboration.replaceMany).
 */
import * as Y from "yjs";

export const CHANGES = "changes";
/** The shared map's JSON stays below this; the server refuses updates beyond it. */
export const CHANGES_BYTES = 1_000_000;

export type TrackedChange = {
  kind: "insert" | "delete";
  /** An insertion's first character, or where deleted text was (a Yjs relative position). */
  start: unknown;
  /** An insertion's last character. */
  end?: unknown;
  /** The text a deletion took out. */
  text?: string;
  /** Who made it, and the name shown: a member's, or an AI's as "Codex · member". */
  author: string;
  name: string;
  at: number;
};
export type ChangeAuthor = { author: string; name: string };
/** A change at its place in the text now: an insertion covers [from, to), a deletion sits at from. */
export type ResolvedChange = TrackedChange & { id: string; from: number; to: number };
/** An edit as CodeMirror reports it: [fromA, toA) of the old text became [fromB, toB) of the new. */
export type TextEdit = { fromA: number; toA: number; fromB: number; toB: number; deleted: string };

export const changesOf = (doc: Y.Doc) => doc.getMap<TrackedChange>(CHANGES);
/** A member's hue, as their cursor and their changes are coloured everywhere. */
export const userHue = (user: string) =>
  [...user].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);

const anchor = (text: Y.Text, index: number, assoc: number) =>
  Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index, assoc));

function place(doc: Y.Doc, json: unknown) {
  if (!json || typeof json !== "object") return null;
  // Typed before resolving, so a root still untyped after an update becomes this text first.
  const text = doc.getText("content");
  try {
    const at = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(json),
      doc,
    );
    return at && at.type === text ? at.index : null;
  } catch {
    return null;
  }
}

function valid(change: unknown): change is TrackedChange {
  if (!change || typeof change !== "object") return false;
  const c = change as Partial<TrackedChange>;
  return (
    (c.kind === "insert" || (c.kind === "delete" && typeof c.text === "string")) &&
    typeof c.author === "string" &&
    typeof c.name === "string" &&
    typeof c.at === "number"
  );
}

/**
 * Every change at its place, in text order. `lost` are those with nothing left to show: an
 * insertion whose text was deleted by someone not tracking, or an entry that makes no sense.
 */
export function resolveChanges(doc: Y.Doc): { changes: ResolvedChange[]; lost: string[] } {
  const changes: ResolvedChange[] = [],
    lost: string[] = [];
  for (const [id, change] of changesOf(doc).entries()) {
    if (!valid(change)) {
      lost.push(id);
      continue;
    }
    const from = place(doc, change.start);
    const to = change.kind === "insert" ? place(doc, change.end) : from;
    if (from === null || to === null || (change.kind === "insert" ? to <= from : !change.text))
      lost.push(id);
    else changes.push({ ...change, id, from, to });
  }
  // A deletion before the insertion that replaced it, as the text reads: "old" struck, then "new".
  changes.sort(
    (a, b) =>
      a.from - b.from || Number(a.kind === "insert") - Number(b.kind === "insert") || a.at - b.at,
  );
  return { changes, lost };
}

/**
 * Lost changes old enough to forget: younger ones may only be waiting for the text they
 * point into (an update can bring a change before the edit it records reaches this copy).
 */
export function staleChanges(doc: Y.Doc, now = Date.now(), age = 120_000) {
  const map = changesOf(doc);
  return resolveChanges(doc).lost.filter((id) => {
    const at = (map.get(id) as Partial<TrackedChange> | undefined)?.at;
    return typeof at !== "number" || now - at > age;
  });
}

let sequence = 0;
const newId = (doc: Y.Doc, now: number) =>
  `${doc.clientID.toString(36)}.${now.toString(36)}.${(sequence++).toString(36)}`;

/**
 * Records edits already made to the text as changes by `who`. `before` are the changes as they
 * stood in the old text. Call inside the transaction that made the edits (or right after it).
 *
 * As on Overleaf: deleting part of an insertion just removes those characters; deleting next
 * to one's own deletion merges into it; typing next to one's own insertion extends it.
 */
export function trackEdits(
  doc: Y.Doc,
  before: ResolvedChange[],
  edits: TextEdit[],
  who: ChangeAuthor,
  now = Date.now(),
) {
  const text = doc.getText("content"),
    map = changesOf(doc);
  const inserts = before.filter((c) => c.kind === "insert");
  for (const { fromA, toA, fromB, toB, deleted } of edits) {
    if (toA > fromA) {
      for (const c of inserts) if (c.from >= fromA && c.to <= toA) map.delete(c.id);
      // The member's own deletions at the edges or inside merge with this one, in text order.
      const merged = before.filter(
        (c) => c.kind === "delete" && c.author === who.author && c.from >= fromA && c.from <= toA,
      );
      const cuts = new Set([fromA, toA, ...merged.map((c) => c.from)]);
      for (const c of inserts)
        for (const edge of [c.from, c.to]) if (edge > fromA && edge < toA) cuts.add(edge);
      const points = [...cuts].sort((a, b) => a - b);
      let removed = "",
        original = false;
      points.forEach((point, i) => {
        for (const c of merged) if (c.from === point) removed += c.text;
        const next = points[i + 1];
        if (next === undefined || inserts.some((c) => c.from <= point && next <= c.to)) return;
        removed += deleted.slice(point - fromA, next - fromA);
        original = true;
      });
      if (original) {
        for (const c of merged) map.delete(c.id);
        map.set(newId(doc, now), {
          kind: "delete",
          start: anchor(text, fromB, -1),
          text: removed,
          ...who,
          at: now,
        });
      }
    }
    if (toB <= fromB) continue;
    const own = inserts.filter((c) => c.author === who.author && map.has(c.id));
    // Typed inside one's own insertion: its anchors already enclose the new text.
    if (own.some((c) => c.from < fromA && toA < c.to)) continue;
    const ending = own.find((c) => c.to === fromA),
      starting = own.find((c) => c.from === toA);
    const stored = (c: ResolvedChange) => map.get(c.id) as TrackedChange;
    if (ending) map.set(ending.id, { ...stored(ending), end: anchor(text, toB, -1), at: now });
    else if (starting)
      map.set(starting.id, { ...stored(starting), start: anchor(text, fromB, 0), at: now });
    else
      map.set(newId(doc, now), {
        kind: "insert",
        start: anchor(text, fromB, 0),
        end: anchor(text, toB, -1),
        ...who,
        at: now,
      });
  }
}

/**
 * Accepting keeps the text as it is and forgets the change; rejecting deletes an insertion's
 * text or puts a deletion's text back. Call inside a transaction.
 */
export function decideChanges(doc: Y.Doc, ids: Iterable<string>, accept: boolean) {
  const text = doc.getText("content"),
    map = changesOf(doc);
  for (const id of ids) {
    const change = map.get(id);
    if (change === undefined) continue;
    map.delete(id);
    if (accept || !valid(change)) continue;
    const from = place(doc, change.start);
    if (from === null) continue;
    if (change.kind === "delete") text.insert(from, change.text ?? "");
    else {
      const to = place(doc, change.end);
      if (to !== null && to > from) text.delete(from, to - from);
    }
  }
}

/** The edits that turned `before` into the text now, from a character diff's operations. */
export function editsFromOperations(
  before: string,
  operations: { at: number; remove: number; insert: string }[],
): TextEdit[] {
  let shift = 0;
  return operations.map(({ at, remove, insert }) => {
    const edit = {
      fromA: at,
      toA: at + remove,
      fromB: at + shift,
      toB: at + shift + insert.length,
      deleted: before.slice(at, at + remove),
    };
    shift += insert.length - remove;
    return edit;
  });
}
