import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { latexFolding, latexHighlighting, latexLanguage } from "@lmms-lab/latex-editor";
import { useEffect, useRef } from "react";
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { Comment, Role } from "../shared/api";
import { base64, unbase64 } from "./api";
import { i18n } from "./i18n";
import { latexCompletion, type ProjectHints } from "./latex-completion";
import { type Person, type SyncStatus, WriterProvider } from "./provider";
export type Selection = { quote: string; start: string; end: string };
const LIMIT = 2_000_000;
/** Comment highlights follow edits by position mapping between (throttled) re-anchors. */
const setMarks = StateEffect.define<DecorationSet>();
const commentMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) if (effect.is(setMarks)) return effect.value;
    return marks.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});
export type EditorHandle = {
  text: () => string;
  selection: () => Selection | null;
  insert: (text: string) => void;
  focusComment: (comment: Comment) => void;
  /** 1-based line of the cursor, for jumping to the PDF. */
  line: () => number;
  /** Move the cursor to the start of a 1-based line and scroll it into view. */
  reveal: (line: number) => void;
};
export function Editor({
  project,
  file,
  user,
  role,
  comments,
  onRole,
  onStatus,
  onError,
  onReady,
  hints,
}: {
  project: string;
  file: string;
  user: Person;
  role: Role;
  comments: Comment[];
  onRole: (role: Role) => void;
  onStatus: (s: SyncStatus) => void;
  onError: (e: string) => void;
  onReady: (handle: EditorHandle | null) => void;
  /** Read lazily on each completion, so new keys appear without recreating the editor. */
  hints: () => ProjectHints;
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    provider = useRef<WriterProvider | null>(null);
  const editability = useRef(new Compartment());
  const callbacks = useRef({ onRole, onStatus, onError, onReady, hints });
  callbacks.current = { onRole, onStatus, onError, onReady, hints };
  const readOnly = useRef(role);
  readOnly.current = role;
  useEffect(() => {
    if (!host.current) return;
    const p = new WriterProvider(
      project,
      file,
      user,
      (s) => callbacks.current.onStatus(s),
      (r) => callbacks.current.onRole(r),
      (e) => callbacks.current.onError(e),
    );
    provider.current = p;
    const text = p.doc.getText("content"),
      undo = new Y.UndoManager(text);
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          EditorState.transactionFilter.of((transaction) => {
            // Never drop remote changes: the editor would silently diverge from the shared doc.
            if (!transaction.docChanged || transaction.annotation(ySyncAnnotation) !== undefined)
              return transaction;
            // A UTF-16 unit is at most 3 UTF-8 bytes; only encode when near the limit.
            if (
              transaction.newDoc.length * 3 > LIMIT &&
              new TextEncoder().encode(transaction.newDoc.toString()).length > LIMIT
            ) {
              queueMicrotask(() => callbacks.current.onError(i18n.t("editor.tooLarge")));
              return [];
            }
            return transaction;
          }),
          lineNumbers(),
          latexLanguage,
          latexHighlighting(false),
          latexFolding,
          foldGutter(),
          EditorView.lineWrapping,
          highlightActiveLine(),
          bracketMatching(),
          closeBrackets(),
          search({ top: true }),
          highlightSelectionMatches(),
          autocompletion({ override: [latexCompletion(() => callbacks.current.hints())] }),
          keymap.of([
            ...yUndoManagerKeymap,
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...completionKeymap,
            ...defaultKeymap,
          ]),
          yCollab(text, p.awareness, { undoManager: undo }),
          editability.current.of(
            EditorState.readOnly.of(!["owner", "editor"].includes(readOnly.current)),
          ),
          commentMarks,
          EditorView.contentAttributes.of({
            "aria-label": i18n.t("editor.label"),
            spellcheck: "false",
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "15px" },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: '"SF Mono",Menlo,"PingFang SC",monospace',
            },
            ".cm-content": { padding: "16px 0" },
            ".cm-line": { padding: "0 12px" },
            ".cm-gutters": {
              background: "#f8fafb",
              borderRight: "1px solid #e2e6ea",
              color: "#7a858e",
            },
            ".writer-comment": { background: "#ffefb6", borderBottom: "2px solid #dba323" },
            ".writer-comment-resolved": { borderBottom: "2px solid #39a471" },
          }),
        ],
      }),
    });
    view.current = v;
    callbacks.current.onReady({
      text: () => v.state.doc.toString(),
      selection: () => {
        const s = v.state.selection.main;
        if (s.empty) return null;
        return {
          quote: v.state.sliceDoc(s.from, s.to),
          start: base64(
            Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, s.from)),
          ),
          end: base64(
            Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, s.to, -1)),
          ),
        };
      },
      insert: (insert) => {
        if (!p.editable) return;
        v.dispatch(v.state.replaceSelection(insert));
        v.focus();
      },
      line: () => v.state.doc.lineAt(v.state.selection.main.head).number,
      reveal: (line) => {
        const target = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines));
        v.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
        v.focus();
      },
      focusComment: (c) => {
        try {
          const a = Y.createAbsolutePositionFromRelativePosition(
              Y.decodeRelativePosition(unbase64(c.start)),
              p.doc,
            ),
            z = Y.createAbsolutePositionFromRelativePosition(
              Y.decodeRelativePosition(unbase64(c.end)),
              p.doc,
            );
          if (!a || !z || a.index >= z.index) throw new Error(i18n.t("editor.anchorLost"));
          v.dispatch({ selection: { anchor: a.index, head: z.index }, scrollIntoView: true });
          v.focus();
        } catch (e) {
          callbacks.current.onError(String(e));
        }
      },
    });
    return () => {
      callbacks.current.onReady(null);
      v.destroy();
      undo.destroy();
      p.destroy();
      view.current = null;
      provider.current = null;
    };
  }, [project, file, user]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editability.current.reconfigure([
        EditorState.readOnly.of(!["owner", "editor"].includes(role)),
        EditorView.editable.of(["owner", "editor"].includes(role)),
      ]),
    });
  }, [role]);
  useEffect(() => {
    const v = view.current,
      p = provider.current;
    if (!v || !p) return;
    const decorate = () => {
      const ranges = [];
      for (const c of comments.filter((c) => c.file === file)) {
        try {
          const a = Y.createAbsolutePositionFromRelativePosition(
              Y.decodeRelativePosition(unbase64(c.start)),
              p.doc,
            ),
            z = Y.createAbsolutePositionFromRelativePosition(
              Y.decodeRelativePosition(unbase64(c.end)),
              p.doc,
            );
          if (a && z && a.index < z.index && z.index <= v.state.doc.length)
            ranges.push(
              Decoration.mark({
                class: c.resolved ? "writer-comment-resolved" : "writer-comment",
                attributes: { title: `${c.authorName}: ${c.body}` },
              }).range(a.index, z.index),
            );
        } catch {
          /* Orphaned notes stay in the list. */
        }
      }
      v.dispatch({ effects: setMarks.of(Decoration.set(ranges, true)) });
    };
    decorate();
    // Re-anchor from Yjs positions at most a few times per second, not on every keystroke.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      timer ??= setTimeout(() => {
        timer = null;
        if (view.current === v) decorate();
      }, 200);
    };
    p.doc.on("update", update);
    return () => {
      if (timer) clearTimeout(timer);
      p.doc.off("update", update);
    };
  }, [comments, file]);
  return <div ref={host} className="editor-host" />;
}
