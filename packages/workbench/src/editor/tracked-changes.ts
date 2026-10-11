/**
 * Tracked changes in a LaTeX editor, as both apps show them (the model is @lmms-lab/sync/
 * tracked): insertions in their author's colour (the colour of their cursor), deletions struck
 * through where the text was, and hovering either shows who made it, when, with accept and
 * reject. The web feeds the changes from the file's Yjs document; the desktop from its folder
 * sync's copy of it, while the editor shows the same text.
 */
import { type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, WidgetType } from "@codemirror/view";
import { type ResolvedChange, userHue } from "@lmms-lab/sync/tracked";
import { workbenchI18n as i18n } from "../i18n";

/** How long ago, as the web's lists say it. */
function ago(time: number, now = Date.now()) {
  const tag = i18n.getLocale() === "zh" ? "zh-CN" : "en";
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return i18n.t("tracked.justNow");
  const format = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return format.format(-days, "day");
  return new Date(time).toLocaleDateString(tag);
}

/** Puts the changes (at their places in the editor's text) on show. */
export const setTrackedChanges = StateEffect.define<ResolvedChange[]>();

/** The changes at their places in the editor's text, carried along by every edit. */
export const trackedChanges = StateField.define<ResolvedChange[]>({
  create: () => [],
  update(changes, tr) {
    for (const effect of tr.effects) if (effect.is(setTrackedChanges)) return effect.value;
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

export type DecideChanges = (ids: string[], accept: boolean) => void;

function card(changes: ResolvedChange[], view: EditorView, decide: DecideChanges | null) {
  const dom = document.createElement("div");
  dom.className = "cm-tracked-card";
  for (const c of changes) {
    const row = dom.appendChild(document.createElement("div"));
    row.className = "cm-tracked-row";
    row.style.setProperty("--tracked", String(userHue(c.author)));
    const head = row.appendChild(document.createElement("div"));
    head.className = "cm-tracked-head";
    head.textContent = `${i18n.t(c.kind === "insert" ? "tracked.insertedBy" : "tracked.deletedBy", { name: c.name })} · ${ago(c.at)}`;
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
export function trackedTooltip(decide: () => DecideChanges | null) {
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
