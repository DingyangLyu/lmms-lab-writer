/**
 * Track changes in the editor; the model is shared/tracked.ts. While tracking is on, the
 * member's edits are recorded in the file's Yjs document as they reach it. Insertions show in
 * their author's colour (the colour of their cursor), deletions struck through where the text
 * was, and hovering either offers accept and reject.
 */
import { type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, WidgetType } from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";
import type * as Y from "yjs";
import {
  type ChangeAuthor,
  changesOf,
  type ResolvedChange,
  resolveChanges,
  type TextEdit,
  trackEdits,
  userHue,
} from "../shared/tracked";
import { ago } from "./dashboard";
import { i18n } from "./i18n";

/** A change as lists show it, with its text: what was inserted, or what was deleted. */
export type ShownChange = ResolvedChange & { quote: string };

/** Tracked edits and decisions: undone together with the text they belong to. */
export const TRACK_ORIGIN = { trackChanges: true };

const setTracked = StateEffect.define<ResolvedChange[]>();

/** The changes at their places in the editor's text, carried along by every edit. */
export const trackedChanges = StateField.define<ResolvedChange[]>({
  create: () => [],
  update(changes, tr) {
    for (const effect of tr.effects) if (effect.is(setTracked)) return effect.value;
    if (!tr.docChanged) return changes;
    const next: ResolvedChange[] = [];
    for (const c of changes) {
      // As in Yjs: text typed where a deletion sits goes after it ("old" struck, then "new").
      if (c.kind === "delete") {
        const at = tr.changes.mapPos(c.from, -1);
        next.push({ ...c, from: at, to: at });
        continue;
      }
      const from = tr.changes.mapPos(c.from, 1),
        to = tr.changes.mapPos(c.to, -1);
      if (to > from) next.push({ ...c, from, to });
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, decorate),
});

/** A deletion's text on one line, shortened in the middle when long. */
export function deletedText(text: string, max = 80) {
  const flat = text.replace(/\r?\n/g, "↵");
  return flat.length > max ? `${flat.slice(0, max / 2)}…${flat.slice(-max / 4)}` : flat;
}

class Deleted extends WidgetType {
  constructor(readonly change: ResolvedChange) {
    super();
  }
  eq(other: Deleted) {
    return other.change.id === this.change.id && other.change.text === this.change.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-tracked-delete";
    span.style.setProperty("--tracked", String(userHue(this.change.author)));
    span.textContent = deletedText(this.change.text ?? "");
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

function decorate(changes: ResolvedChange[]) {
  const ranges: Range<Decoration>[] = [];
  for (const c of changes)
    ranges.push(
      c.kind === "insert"
        ? Decoration.mark({
            class: "cm-tracked-insert",
            attributes: { style: `--tracked: ${userHue(c.author)}` },
          }).range(c.from, c.to)
        : Decoration.widget({ widget: new Deleted(c), side: 1 }).range(c.from),
    );
  return Decoration.set(ranges, true);
}

/** Changes touching `pos`: the insertions over it and a deletion right there. */
const changesAt = (changes: readonly ResolvedChange[], pos: number) =>
  changes.filter((c) => (c.kind === "insert" ? c.from <= pos && pos <= c.to : c.from === pos));

type Decide = (ids: string[], accept: boolean) => void;

function card(changes: ResolvedChange[], view: EditorView, decide: Decide | null) {
  const dom = document.createElement("div");
  dom.className = "cm-tracked-card";
  for (const c of changes) {
    const row = dom.appendChild(document.createElement("div"));
    row.className = "cm-tracked-row";
    row.style.setProperty("--tracked", String(userHue(c.author)));
    const head = row.appendChild(document.createElement("div"));
    head.className = "cm-tracked-head";
    head.textContent = `${i18n.t(c.kind === "insert" ? "tracked.insertedBy" : "tracked.deletedBy", { name: c.name })} · ${ago(c.at, i18n.getLocale(), i18n.t("dash.justNow"))}`;
    const quote = row.appendChild(document.createElement("div"));
    quote.className = c.kind === "insert" ? "cm-tracked-quote" : "cm-tracked-quote cm-tracked-gone";
    quote.textContent = deletedText(
      c.kind === "insert" ? view.state.sliceDoc(c.from, c.to) : (c.text ?? ""),
      160,
    );
    if (!decide) continue;
    const actions = row.appendChild(document.createElement("div"));
    actions.className = "cm-tracked-actions";
    for (const accept of [true, false]) {
      const button = actions.appendChild(document.createElement("button"));
      button.type = "button";
      button.textContent = i18n.t(accept ? "tracked.accept" : "tracked.reject");
      button.className = accept ? "cm-tracked-accept" : "cm-tracked-reject";
      // Keep the editor's focus and selection while deciding.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        decide([c.id], accept);
        row.remove();
        if (!dom.childElementCount) dom.remove();
      });
    }
  }
  return dom;
}

/** Hovering an insertion or a deletion shows who made it, when, and accept and reject. */
export function trackedTooltip(decide: () => Decide | null) {
  return hoverTooltip(
    (view, pos) => {
      const hits = changesAt(view.state.field(trackedChanges), pos);
      if (!hits.length) return null;
      return {
        pos: Math.min(...hits.map((c) => c.from)),
        end: Math.max(...hits.map((c) => c.to)),
        above: true,
        create: (v) => ({ dom: card(hits, v, decide()) }),
      };
    },
    { hoverTime: 250 },
  );
}

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
    const { changes } = resolveChanges(doc);
    // Positions are the Yjs text's; skip a moment when the editor has not caught up.
    if (doc.getText("content").length !== view.state.doc.length) return;
    if (!changes.length && !shown) return;
    shown = changes.length > 0;
    view.dispatch({ effects: setTracked.of(changes) });
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

export const trackedTheme = EditorView.baseTheme({
  ".cm-tracked-insert": {
    backgroundColor: "hsl(var(--tracked) 70% 45% / 0.13)",
    borderBottom: "2px solid hsl(var(--tracked) 65% 42%)",
  },
  ".cm-tracked-delete": {
    color: "#b91c1c",
    backgroundColor: "rgb(239 68 68 / 0.08)",
    textDecoration: "line-through",
    borderLeft: "2px solid hsl(var(--tracked) 65% 42%)",
    padding: "0 1px",
    cursor: "default",
  },
  "&dark .cm-tracked-delete": { color: "#fca5a5" },
  ".cm-tracked-card": {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxWidth: "340px",
    padding: "6px 8px",
    fontFamily: "system-ui, sans-serif",
    fontSize: "12px",
  },
  ".cm-tracked-row": { borderLeft: "3px solid hsl(var(--tracked) 65% 42%)", paddingLeft: "6px" },
  ".cm-tracked-head": { opacity: 0.75 },
  ".cm-tracked-quote": {
    margin: "2px 0",
    fontFamily: "ui-monospace, monospace",
    wordBreak: "break-all",
  },
  ".cm-tracked-gone": { textDecoration: "line-through", color: "#b91c1c" },
  "&dark .cm-tracked-gone": { color: "#fca5a5" },
  ".cm-tracked-actions": { display: "flex", gap: "6px", marginTop: "2px" },
  ".cm-tracked-actions button": {
    border: "1px solid currentColor",
    padding: "0 6px",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
  },
  ".cm-tracked-actions .cm-tracked-accept": { color: "#047857" },
  "&dark .cm-tracked-actions .cm-tracked-accept": { color: "#6ee7b7" },
});
