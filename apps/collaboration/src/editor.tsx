import { autocompletion, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab, toggleLineComment } from "@codemirror/commands";
import { bracketMatching, foldKeymap } from "@codemirror/language";
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import { latexLanguage } from "@lmms-lab/latex-editor";
import {
  DEFAULT_EDITOR_SETTINGS,
  editorConfiguration,
  FoldToolbar,
  latexFoldExtensions,
} from "@lmms-lab/workbench";
import { type ReactNode, useEffect, useRef } from "react";
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { Comment, Role } from "../shared/api";
import { base64, errorText, unbase64 } from "./api";
import { i18n } from "./i18n";
import { latexCompletion, type ProjectHints } from "./latex-completion";
import { type FilePosition, readPosition, writePosition } from "./positions";
import { type Person, type SyncStatus, WriterProvider } from "./provider";
export type Selection = { quote: string; start: string; end: string; from: number; to: number };
/** A collaborator in the same file, as their cursor shows them. */
export type Peer = { name: string; color: string };
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
  /** Where each highlighted comment is now, following edits since the comments loaded. */
  commentRanges: () => Map<string, { from: number; to: number }>;
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
  onText,
  onPeers,
  actions,
  activeComment,
  onCommentClick,
  onSelect,
  onLayout,
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
  /** The text, at most a few times a second, for the outline. */
  onText?: (text: string) => void;
  /** Everyone else editing this file, from the collaboration cursors. */
  onPeers?: (peers: Peer[]) => void;
  /** Buttons at the right of the toolbar above the text. */
  actions?: ReactNode;
  /** The thread shown as selected, drawn stronger in the text. */
  activeComment?: string | null;
  /** A click on commented text. */
  onCommentClick?: (id: string) => void;
  /** The selection's offsets as it changes, or null when nothing is selected. */
  onSelect?: (range: { from: number; to: number } | null) => void;
  /** The CodeMirror view and every scroll, resize or edit, for the review margin. */
  onLayout?: (view: EditorView | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    provider = useRef<WriterProvider | null>(null);
  const editability = useRef(new Compartment());
  const callbacks = useRef({
    onRole,
    onStatus,
    onError,
    onReady,
    hints,
    onText,
    onPeers,
    onCommentClick,
    onSelect,
    onLayout,
  });
  callbacks.current = {
    onRole,
    onStatus,
    onError,
    onReady,
    hints,
    onText,
    onPeers,
    onCommentClick,
    onSelect,
    onLayout,
  };
  const readOnly = useRef(role);
  readOnly.current = role;
  useEffect(() => {
    if (!host.current) return;
    // The member's place in this file comes back once its text has arrived from the server,
    // and is saved as they scroll or move the cursor.
    let restored = false,
      restore = () => {},
      remember = () => {},
      latest: FilePosition | null = null,
      saveTimer: ReturnType<typeof setTimeout> | null = null;
    const p = new WriterProvider(
      project,
      file,
      user,
      (s) => {
        callbacks.current.onStatus(s);
        if (s === "saved" && !restored) restore();
      },
      (r) => callbacks.current.onRole(r),
      (e) => callbacks.current.onError(e),
    );
    provider.current = p;
    const text = p.doc.getText("content"),
      undo = new Y.UndoManager(text);
    const canEdit = () => ["owner", "editor"].includes(readOnly.current);
    let textTimer: ReturnType<typeof setTimeout> | null = null;
    const reportPeers = () =>
      callbacks.current.onPeers?.(
        [...p.awareness.getStates()]
          .filter(([client]) => client !== p.doc.clientID)
          .map(([, state]) => state.user as Peer | undefined)
          .filter((user): user is Peer => !!user?.name),
      );
    p.awareness.on("change", reportPeers);
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
          latexLanguage,
          latexFoldExtensions(),
          drawSelection(),
          rectangularSelection(),
          bracketMatching(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          highlightSpecialChars(),
          search({ top: true }),
          autocompletion({ override: [latexCompletion(() => callbacks.current.hints())] }),
          keymap.of([
            { key: "Mod-/", run: toggleLineComment },
            { key: "Ctrl-g", run: gotoLine },
            ...yUndoManagerKeymap,
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...completionKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          yCollab(text, p.awareness, { undoManager: undo }),
          // The desktop editor's theme, gutters, wrapping and brackets, read-only by role.
          editability.current.of(editorConfiguration(DEFAULT_EDITOR_SETTINGS, false, !canEdit())),
          commentMarks,
          EditorView.contentAttributes.of({
            "aria-label": i18n.t("editor.label"),
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
          }),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.docChanged) {
              const main = update.state.selection.main;
              callbacks.current.onSelect?.(main.empty ? null : { from: main.from, to: main.to });
            }
            if (update.selectionSet) remember();
            if (update.docChanged || update.geometryChanged || update.viewportChanged)
              callbacks.current.onLayout?.(update.view);
            if (!update.docChanged || !callbacks.current.onText) return;
            textTimer ??= setTimeout(() => {
              textTimer = null;
              callbacks.current.onText?.(update.view.state.doc.toString());
            }, 400);
          }),
          EditorView.domEventHandlers({
            click: (event) => {
              const id = (event.target as HTMLElement)
                .closest("[data-comment]")
                ?.getAttribute("data-comment");
              if (id) callbacks.current.onCommentClick?.(id);
              return false;
            },
            scroll: (_event, view) => {
              callbacks.current.onLayout?.(view);
              remember();
            },
          }),
        ],
      }),
    });
    view.current = v;
    // Measured while the editor is on screen (once removed, its scroll reads as 0), stored a
    // moment later, and written once more when the file closes.
    remember = () => {
      if (!restored || !v.dom.isConnected) return;
      const doc = v.state.doc,
        head = doc.lineAt(v.state.selection.main.head);
      latest = {
        top: doc.lineAt(v.lineBlockAtHeight(v.scrollDOM.scrollTop).from).number,
        line: head.number,
        ch: v.state.selection.main.head - head.from,
      };
      saveTimer ??= setTimeout(() => {
        saveTimer = null;
        if (latest) writePosition(project, file, latest);
      }, 300);
    };
    restore = () => {
      restored = true;
      const saved = readPosition(project, file);
      if (!saved) return;
      const doc = v.state.doc,
        clamp = (line: number) => doc.line(Math.min(Math.max(line, 1), doc.lines));
      const line = clamp(saved.line);
      v.dispatch({
        selection: { anchor: Math.min(line.from + saved.ch, line.to) },
        effects: EditorView.scrollIntoView(clamp(saved.top).from, { y: "start" }),
      });
    };
    callbacks.current.onLayout?.(v);
    callbacks.current.onText?.(v.state.doc.toString());
    reportPeers();
    callbacks.current.onReady({
      text: () => v.state.doc.toString(),
      selection: () => {
        const s = v.state.selection.main;
        if (s.empty) return null;
        return {
          from: s.from,
          to: s.to,
          quote: v.state.sliceDoc(s.from, s.to),
          start: base64(
            Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, s.from)),
          ),
          end: base64(
            Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, s.to, -1)),
          ),
        };
      },
      commentRanges: () => {
        const ranges = new Map<string, { from: number; to: number }>();
        v.state.field(commentMarks).between(0, v.state.doc.length, (from, to, deco) => {
          const id = deco.spec.attributes?.["data-comment"];
          if (typeof id === "string" && !ranges.has(id)) ranges.set(id, { from, to });
        });
        return ranges;
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
          callbacks.current.onError(errorText(e));
        }
      },
    });
    return () => {
      if (textTimer) clearTimeout(textTimer);
      if (saveTimer) clearTimeout(saveTimer);
      if (latest) writePosition(project, file, latest);
      p.awareness.off("change", reportPeers);
      callbacks.current.onPeers?.([]);
      callbacks.current.onLayout?.(null);
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
      effects: editability.current.reconfigure(
        editorConfiguration(DEFAULT_EDITOR_SETTINGS, false, !["owner", "editor"].includes(role)),
      ),
    });
  }, [role]);
  useEffect(() => {
    const v = view.current,
      p = provider.current;
    if (!v || !p) return;
    const decorate = () => {
      const ranges = [];
      for (const c of comments.filter((c) => c.file === file && !c.resolved)) {
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
                class: `writer-note-highlight ${c.id === activeComment ? "writer-note-active" : ""}`,
                attributes: { title: `${c.authorName}: ${c.body}`, "data-comment": c.id },
              }).range(a.index, z.index),
            );
        } catch {
          /* Orphaned notes stay in the list. */
        }
      }
      v.dispatch({ effects: setMarks.of(Decoration.set(ranges, true)) });
      callbacks.current.onLayout?.(v);
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
  }, [comments, file, activeComment]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FoldToolbar view={() => view.current} actions={actions} />
      <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
