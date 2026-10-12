/**
 * Collaborators' cursors and selections in an editor that is not bound to the shared document
 * itself (the desktop's, fed by folder sync): a coloured caret with the name, and a tint over
 * what they selected.
 */
import { type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

export type EditorCursor = {
  id: number;
  name: string;
  color: string;
  anchor: number;
  head: number;
};

class Caret extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }
  eq(other: Caret) {
    return other.name === this.name && other.color === this.color;
  }
  toDOM() {
    const caret = document.createElement("span");
    caret.className = "cm-remote-caret";
    caret.style.borderLeftColor = this.color;
    const label = document.createElement("span");
    label.textContent = this.name;
    label.style.backgroundColor = this.color;
    caret.append(label);
    return caret;
  }
  ignoreEvent() {
    return true;
  }
}

export const setRemoteCursors = StateEffect.define<EditorCursor[]>();
const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    for (const effect of tr.effects)
      if (effect.is(setRemoteCursors)) {
        const length = tr.state.doc.length;
        const ranges: Range<Decoration>[] = [];
        for (const c of effect.value) {
          const anchor = Math.min(c.anchor, length),
            head = Math.min(c.head, length);
          if (anchor !== head)
            ranges.push(
              Decoration.mark({
                attributes: { style: `background-color: ${c.color}33` },
              }).range(Math.min(anchor, head), Math.max(anchor, head)),
            );
          ranges.push(
            Decoration.widget({ widget: new Caret(c.name, c.color), side: 1 }).range(head),
          );
        }
        return Decoration.set(ranges, true);
      }
    return set.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const remoteCursors = [
  field,
  EditorView.baseTheme({
    ".cm-remote-caret": {
      position: "relative",
      borderLeft: "2px solid",
      marginLeft: "-1px",
      marginRight: "-1px",
    },
    ".cm-remote-caret > span": {
      position: "absolute",
      top: "-1.15em",
      left: "-2px",
      fontSize: "10px",
      lineHeight: "1.2",
      color: "#fff",
      padding: "0 3px",
      whiteSpace: "nowrap",
      fontFamily: "system-ui, sans-serif",
      pointerEvents: "none",
      opacity: "0.9",
    },
  }),
];
