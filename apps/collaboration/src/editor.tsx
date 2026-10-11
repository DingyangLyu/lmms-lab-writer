import { autocompletion, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab, toggleLineComment } from "@codemirror/commands";
import { bracketMatching, foldKeymap } from "@codemirror/language";
import { gotoLine, highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  GutterMarker,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import { latexLanguage } from "@lmms-lab/latex-editor";
import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
  editorConfiguration,
  FoldToolbar,
  latexFoldExtensions,
  symbolInsertion,
  writerSearch,
} from "@lmms-lab/workbench";
import type { EditorTextRange } from "@lmms-lab/workbench/agents";
import { type ReactNode, useEffect, useRef } from "react";
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { Comment, Role } from "../shared/api";
import { changesOf, decideChanges } from "../shared/tracked";
import { base64, errorText, unbase64 } from "./api";
import { i18n } from "./i18n";
import { latexCompletion, type ProjectHints } from "./latex-completion";
import { type FilePosition, readPosition, writePosition } from "./positions";
import { type Person, type SyncStatus, WriterProvider } from "./provider";
import { latexSpellcheck } from "./spellcheck";
import {
  changeTracker,
  followChanges,
  type ShownChange,
  TRACK_ORIGIN,
  trackedChanges,
  trackedTheme,
  trackedTooltip,
} from "./tracked-changes";
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
/** Where the comment being written starts in this file, following edits. */
const setDraftAt = StateEffect.define<number | null>();
const draftAt = StateField.define<number | null>({
  create: () => null,
  update(at, transaction) {
    for (const effect of transaction.effects) if (effect.is(setDraftAt)) return effect.value;
    return at === null ? null : transaction.changes.mapPos(at);
  },
});
const NOTE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" opacity=".28" d="M3 2h10v8l-4 4H3z"/><path fill="currentColor" d="M3.5 1.5h9A1.5 1.5 0 0 1 14 3v7.2L9.7 14.5H3.5A1.5 1.5 0 0 1 2 13V3a1.5 1.5 0 0 1 1.5-1.5Zm0 1A.5.5 0 0 0 3 3v10a.5.5 0 0 0 .5.5H9v-3A1.5 1.5 0 0 1 10.5 9H13V3a.5.5 0 0 0-.5-.5Zm6.5 10.6 2.1-2.1h-1.6a.5.5 0 0 0-.5.5Z"/></svg>';
/** A sticky note beside a line with comments (or the one being written); a click opens them. */
class NoteMarker extends GutterMarker {
  constructor(
    readonly ids: string[],
    readonly draft: boolean,
    readonly active: boolean,
  ) {
    super();
  }
  eq(other: NoteMarker) {
    return (
      other.ids.join() === this.ids.join() &&
      other.draft === this.draft &&
      other.active === this.active
    );
  }
  toDOM() {
    const marker = document.createElement("span");
    marker.className = `cm-note-marker${this.draft ? " cm-note-draft" : ""}${this.active ? " cm-note-active" : ""}`;
    marker.setAttribute("data-note-ids", this.ids.join(" "));
    if (this.draft) marker.setAttribute("data-note-draft", "");
    marker.title = this.draft
      ? i18n.t("notes.draftNote")
      : this.ids.length > 1
        ? i18n.t("notes.noteCount", { count: this.ids.length })
        : i18n.t("notes.openNote");
    marker.innerHTML = NOTE_ICON + (this.ids.length > 1 ? `<b>${this.ids.length}</b>` : "");
    return marker;
  }
}
const SPACER = new NoteMarker([], false, false);
/** The notes gutter: comment markers come from the highlighted comments, plus the draft. */
function noteGutter(onIcon: (ids: string[], draft: boolean) => void) {
  return [
    gutter({
      class: "cm-note-gutter",
      markers: (view) => {
        const doc = view.state.doc;
        const lines = new Map<number, { ids: string[]; active: boolean; draft: boolean }>();
        const at = (pos: number) => {
          const line = doc.lineAt(Math.min(pos, doc.length)).from;
          const entry = lines.get(line) ?? { ids: [], active: false, draft: false };
          lines.set(line, entry);
          return entry;
        };
        view.state.field(commentMarks).between(0, doc.length, (from, _to, decoration) => {
          const id = decoration.spec.attributes?.["data-comment"];
          if (!id) return;
          const entry = at(from);
          if (!entry.ids.includes(id)) entry.ids.push(id);
          if (String(decoration.spec.class).includes("writer-note-active")) entry.active = true;
        });
        const draft = view.state.field(draftAt);
        if (draft !== null) at(draft).draft = true;
        const builder = new RangeSetBuilder<GutterMarker>();
        for (const [line, entry] of [...lines].sort(([a], [b]) => a - b))
          builder.add(line, line, new NoteMarker(entry.ids, entry.draft, entry.active));
        return builder.finish();
      },
      lineMarkerChange: (update) =>
        update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(setMarks) || effect.is(setDraftAt)),
        ),
      initialSpacer: () => SPACER,
      domEventHandlers: {
        mousedown: (_view, _line, event) => {
          const marker = (event.target as HTMLElement).closest?.(".cm-note-marker");
          if (!marker) return false;
          event.preventDefault();
          onIcon(
            (marker.getAttribute("data-note-ids") ?? "").split(" ").filter(Boolean),
            marker.hasAttribute("data-note-draft"),
          );
          return true;
        },
      },
    }),
    EditorView.baseTheme({
      ".cm-note-gutter": { width: "18px" },
      ".cm-note-gutter .cm-gutterElement": { padding: "0 1px", display: "flex" },
      ".cm-note-marker": {
        position: "relative",
        display: "inline-flex",
        width: "15px",
        height: "15px",
        marginTop: "0.2em",
        color: "#d97706",
        cursor: "pointer",
      },
      ".cm-note-marker:hover": { color: "#b45309" },
      ".cm-note-marker svg": { width: "15px", height: "15px" },
      ".cm-note-marker b": {
        position: "absolute",
        right: "-3px",
        top: "-5px",
        fontSize: "9px",
        fontWeight: "700",
      },
      ".cm-note-active": { color: "#b45309", background: "#fde68a" },
      ".cm-note-draft": { color: "#ea580c", animation: "cm-note-pulse 1.6s ease-in-out infinite" },
      "@keyframes cm-note-pulse": { "50%": { opacity: 0.45 } },
    }),
  ];
}
/** The desktop editor's theme, gutters, wrapping and brackets with the member's settings, read-only by role. */
const configuration = (settings: Partial<EditorSettings>, role: Role) =>
  editorConfiguration(
    { ...DEFAULT_EDITOR_SETTINGS, ...settings },
    false,
    !["owner", "editor"].includes(role),
  );
export type EditorHandle = {
  text: () => string;
  selection: () => Selection | null;
  /** Where each highlighted comment is now, following edits since the comments loaded. */
  commentRanges: () => Map<string, { from: number; to: number }>;
  insert: (text: string) => void;
  /** A command from the symbol palette, spaced from a letter that follows. */
  insertSymbol: (command: string) => void;
  focusComment: (comment: Comment) => void;
  /** 1-based line of the cursor, for jumping to the PDF. */
  line: () => number;
  /** Accept or reject tracked changes; null means every change in the file. */
  decide: (ids: string[] | null, accept: boolean) => void;
  /** Select a tracked change's text (or put the cursor where deleted text was). */
  revealChange: (id: string) => void;
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
  draftAt: draftStart = null,
  onNoteIcon,
  settings = DEFAULT_EDITOR_SETTINGS,
  spellcheck = false,
  tracking = false,
  onChanges,
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
  /** The selection as it changes (offsets, and lines and columns for the AI), or null. */
  onSelect?: (range: { from: number; to: number; range: EditorTextRange } | null) => void;
  /** The CodeMirror view and every scroll, resize or edit, for the review margin. */
  onLayout?: (view: EditorView | null) => void;
  /** Where the comment being written starts in this file, for its note beside the line. */
  draftAt?: number | null;
  /** A click on a note beside the text: the comments on that line, or the draft. */
  onNoteIcon?: (ids: string[], draft: boolean) => void;
  /** Text size, wrapping and the like, as the member chose them. */
  settings?: Partial<EditorSettings>;
  /** The browser's spell checker on the prose; see spellcheck.ts. */
  spellcheck?: boolean;
  /** Record this member's edits as tracked changes (shared/tracked.ts). */
  tracking?: boolean;
  /** The file's tracked changes, whenever they change. */
  onChanges?: (changes: ShownChange[]) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    provider = useRef<WriterProvider | null>(null);
  const editability = useRef(new Compartment()),
    spelling = useRef(new Compartment());
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
    onNoteIcon,
    onChanges,
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
    onNoteIcon,
    onChanges,
  };
  const draftRef = useRef(draftStart);
  draftRef.current = draftStart;
  const readOnly = useRef(role);
  readOnly.current = role;
  const chosen = useRef(settings);
  chosen.current = settings;
  const checked = useRef(spellcheck);
  checked.current = spellcheck;
  const tracks = useRef(tracking);
  tracks.current = tracking;
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
      // Tracked changes are undone with the edits that made them.
      undo = new Y.UndoManager([text, changesOf(p.doc)]);
    undo.addTrackedOrigin(TRACK_ORIGIN);
    const decide = (ids: string[] | null, accept: boolean) => {
      if (!p.editable) return;
      p.doc.transact(
        () => decideChanges(p.doc, ids ?? [...changesOf(p.doc).keys()], accept),
        TRACK_ORIGIN,
      );
    };
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
          writerSearch(),
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
          editability.current.of(configuration(chosen.current, readOnly.current)),
          trackedChanges,
          trackedTheme,
          trackedTooltip(() => (p.editable ? decide : null)),
          changeTracker(p.doc, () =>
            tracks.current && p.editable ? { author: user.id, name: user.name } : null,
          ),
          commentMarks,
          draftAt,
          noteGutter((ids, draft) => callbacks.current.onNoteIcon?.(ids, draft)),
          spelling.current.of(latexSpellcheck(checked.current)),
          EditorView.contentAttributes.of({
            "aria-label": i18n.t("editor.label"),
            autocapitalize: "off",
            autocorrect: "off",
          }),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.docChanged) {
              const main = update.state.selection.main,
                doc = update.state.doc;
              const start = doc.lineAt(main.from),
                end = doc.lineAt(main.to);
              callbacks.current.onSelect?.(
                main.empty
                  ? null
                  : {
                      from: main.from,
                      to: main.to,
                      range: {
                        startLineNumber: start.number,
                        startColumn: main.from - start.from + 1,
                        endLineNumber: end.number,
                        endColumn: main.to - end.from + 1,
                        startOffset: main.from,
                        endOffset: main.to,
                        text: doc.sliceString(main.from, main.to),
                      },
                    },
              );
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
      // The draft's place, set before the text arrived, is placed again in the real text.
      if (draftRef.current !== null)
        v.dispatch({
          effects: setDraftAt.of(Math.min(draftRef.current, v.state.doc.length)),
        });
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
    const stopChanges = followChanges(
      v,
      p.doc,
      (changes) => callbacks.current.onChanges?.(changes),
      () => p.editable,
    );
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
      insertSymbol: (command) => {
        if (!p.editable) return;
        const { to } = v.state.selection.main;
        v.dispatch(
          v.state.replaceSelection(symbolInsertion(command, v.state.doc.sliceString(to, to + 1))),
        );
        v.focus();
      },
      line: () => v.state.doc.lineAt(v.state.selection.main.head).number,
      decide,
      revealChange: (id) => {
        const change = v.state.field(trackedChanges).find((c) => c.id === id);
        if (!change) return;
        v.dispatch({
          selection: { anchor: change.from, head: change.to },
          effects: EditorView.scrollIntoView(change.from, { y: "center" }),
        });
        v.focus();
      },
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
      stopChanges();
      callbacks.current.onChanges?.([]);
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
      effects: editability.current.reconfigure(configuration(settings, role)),
    });
  }, [role, settings]);
  useEffect(() => {
    view.current?.dispatch({ effects: spelling.current.reconfigure(latexSpellcheck(spellcheck)) });
  }, [spellcheck]);
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
  useEffect(() => {
    const v = view.current;
    if (v && v.state.field(draftAt) !== draftStart)
      v.dispatch({
        effects: setDraftAt.of(
          draftStart === null ? null : Math.min(draftStart, v.state.doc.length),
        ),
      });
  }, [draftStart]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FoldToolbar view={() => view.current} actions={actions} />
      <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
