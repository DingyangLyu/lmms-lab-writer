/**
 * Track changes in the editor; the model is shared/tracked.ts. While tracking is on, the
 * member's edits are recorded in the file's Yjs document as they reach it. Insertions show in
 * their author's colour (the colour of their cursor), deletions struck through where the text
 * was, and hovering either offers accept and reject.
 */
import { EditorView } from "@codemirror/view";
import { setTrackedChanges, trackedChanges } from "@lmms-lab/workbench";
import { ySyncAnnotation } from "y-codemirror.next";
import type * as Y from "yjs";
import {
  type ChangeAuthor,
  changesOf,
  type ResolvedChange,
  resolveChanges,
  staleChanges,
  type TextEdit,
  trackEdits,
} from "../shared/tracked";

export {
  deletedText,
  trackedChanges,
  trackedTheme,
  trackedTooltip,
} from "@lmms-lab/workbench";

/** A change as lists show it, with its text: what was inserted, or what was deleted. */
export type ShownChange = ResolvedChange & { quote: string };

/** Tracked edits and decisions: undone together with the text they belong to. */
export const TRACK_ORIGIN = { trackChanges: true };
/** Forgetting lost changes: housekeeping, not something to undo. */
const PRUNE_ORIGIN = { pruneChanges: true };

/** Records the member's own edits while `active()`; edits arriving from others are theirs. */
export function changeTracker(doc: Y.Doc, active: () => ChangeAuthor | null) {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const who = active();
    if (!who) return;
    // y-codemirror has written the edit to the Yjs text by now (plugins update before listeners).
    if (update.transactions.some((tr) => tr.docChanged && tr.annotation(ySyncAnnotation))) return;
    const edits: TextEdit[] = [];
    update.changes.iterChanges((fromA, toA, fromB, toB) =>
      edits.push({
        fromA,
        toA,
        fromB,
        toB,
        deleted: update.startState.doc.sliceString(fromA, toA),
      }),
    );
    const before = update.startState.field(trackedChanges);
    doc.transact(() => trackEdits(doc, before, edits, who), TRACK_ORIGIN);
  });
}

/**
 * Keeps the editor's changes in step with the Yjs map: at once when the map changes, and a
 * little after other edits, which the editor otherwise only maps. Returns the stop function.
 */
export function followChanges(
  view: EditorView,
  doc: Y.Doc,
  report: (changes: ShownChange[]) => void,
  /** Whether this member may edit the file, and so tidy its changes. */
  editable: () => boolean = () => false,
) {
  const map = changesOf(doc);
  let stopped = false,
    queued = false,
    timer: ReturnType<typeof setTimeout> | null = null,
    shown = false;
  const refresh = () => {
    queued = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped) return;
    // Changes nobody can see any more (their text deleted by someone not tracking) would
    // otherwise pile up towards the server's limit.
    const stale = editable() ? staleChanges(doc) : [];
    if (stale.length)
      doc.transact(() => {
        for (const id of stale) map.delete(id);
      }, PRUNE_ORIGIN);
    const { changes } = resolveChanges(doc);
    // Positions are the Yjs text's; skip a moment when the editor has not caught up.
    if (doc.getText("content").length !== view.state.doc.length) return;
    if (!changes.length && !shown) return;
    shown = changes.length > 0;
    view.dispatch({ effects: setTrackedChanges.of(changes) });
    report(
      changes.map((c) => ({
        ...c,
        quote: c.kind === "insert" ? view.state.sliceDoc(c.from, c.to) : (c.text ?? ""),
      })),
    );
  };
  // Never inside an editor update: a microtask runs once the current one is done.
  const soon = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(refresh);
  };
  const later = () => {
    timer ??= setTimeout(refresh, 400);
  };
  map.observe(soon);
  doc.on("update", later);
  soon();
  return () => {
    stopped = true;
    map.unobserve(soon);
    doc.off("update", later);
    if (timer) clearTimeout(timer);
  };
}
