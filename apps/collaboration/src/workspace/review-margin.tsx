/**
 * The review margin beside the editor, as in Overleaf: each open thread sits next to the text
 * it is about and follows it while scrolling and editing; a button beside a selection starts a
 * comment there. Resolved threads, and threads whose text was deleted, are listed on demand.
 */
import type { EditorView } from "@codemirror/view";
import { CaretDownIcon, ChatCircleTextIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Comment } from "../../shared/api";
import type { EditorHandle } from "../editor";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import type { CommentDraft } from "./notes";
import { ThreadCard } from "./thread-card";
import { Btn, TextArea } from "./ui";

/** The editor view, and an event fired on every scroll, resize or edit. */
export type MarginLayout = { view: EditorView | null; events: EventTarget };

export function DraftCard({
  ws,
  draft,
  setDraft,
  onSubmit,
  heading,
}: {
  ws: WorkspaceContext;
  draft: CommentDraft;
  setDraft: (draft: CommentDraft | null) => void;
  onSubmit: () => void;
  heading?: string;
}) {
  const { t } = useI18n();
  // A selection in the editor must be saved on the server before it can be anchored.
  const waiting = !!draft.start && ws.status !== "saved";
  return (
    <form
      aria-label={t("shell.newComment")}
      className="space-y-2 border border-orange-400 bg-background p-2.5 text-xs shadow-md"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.body.trim()) onSubmit();
      }}
    >
      {heading && <strong className="block truncate">{heading}</strong>}
      <blockquote className="line-clamp-3 border-l-2 border-orange-400 pl-2 text-muted">
        {draft.quote}
      </blockquote>
      <TextArea
        aria-label={t("comments.body")}
        rows={3}
        value={draft.body}
        autoFocus
        placeholder={t("comments.placeholder")}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && draft.body.trim()) onSubmit();
        }}
      />
      <div className="flex items-center gap-2">
        <Btn
          type="submit"
          tone="solid"
          disabled={ws.busy || !ws.canComment || !draft.body.trim() || waiting}
          title={waiting ? t("notes.waitSync") : undefined}
        >
          {t("comments.post")}
        </Btn>
        <Btn onClick={() => setDraft(null)}>{t("common.cancel")}</Btn>
      </div>
    </form>
  );
}

type Item = { key: string; pos: number };
const GAP = 6;

export function ReviewMargin({
  ws,
  layout,
  editor,
  comments,
  active,
  setActive,
  draft,
  setDraft,
  onSubmit,
  selection,
  onAdd,
  onClose,
}: {
  ws: WorkspaceContext;
  layout: MarginLayout;
  editor: EditorHandle | null;
  /** Every thread of the open file. */
  comments: Comment[];
  active: string | null;
  setActive: (id: string | null) => void;
  /** The draft, when it is for the open file. */
  draft: CommentDraft | null;
  setDraft: (draft: CommentDraft | null) => void;
  onSubmit: () => void;
  selection: { from: number; to: number } | null;
  onAdd: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [, setTick] = useState(0),
    [showOthers, setShowOthers] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    let frame = 0;
    const relayout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((n) => n + 1));
    };
    layout.events.addEventListener("layout", relayout);
    window.addEventListener("resize", relayout);
    return () => {
      cancelAnimationFrame(frame);
      layout.events.removeEventListener("layout", relayout);
      window.removeEventListener("resize", relayout);
    };
  }, [layout]);
  const ranges = editor?.commentRanges() ?? new Map<string, { from: number; to: number }>();
  const open = comments.filter((c) => !c.resolved);
  const placed = open.filter((c) => ranges.has(c.id) || c.from !== null);
  const others = [
    ...comments.filter((c) => c.resolved),
    ...open.filter((c) => !ranges.has(c.id) && c.from === null),
  ];
  const items: Item[] = placed.map((c) => ({
    key: c.id,
    pos: ranges.get(c.id)?.from ?? c.from ?? 0,
  }));
  if (draft) items.push({ key: "draft", pos: draft.from });
  else if (selection && ws.canComment) items.push({ key: "add", pos: selection.from });
  items.sort((a, b) => a.pos - b.pos);
  // Each card wants the height of its line; later cards move down rather than overlap.
  const view = layout.view;
  const origin = area.current?.getBoundingClientRect().top ?? 0;
  const tops = new Map<string, number>();
  let floor = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const wanted = view
      ? view.lineBlockAt(Math.min(item.pos, view.state.doc.length)).top + view.documentTop - origin
      : 0;
    const top = Math.max(wanted, floor);
    tops.set(item.key, top);
    floor = top + (heights.current.get(item.key) ?? (item.key === "add" ? 28 : 72)) + GAP;
  }
  // Measure after drawing; a changed height lays the cards out once more.
  useLayoutEffect(() => {
    let changed = false;
    for (const [key, node] of nodes.current) {
      const height = node.offsetHeight;
      if (heights.current.get(key) !== height) {
        heights.current.set(key, height);
        changed = true;
      }
    }
    if (changed) setTick((n) => n + 1);
  });
  const keep = (key: string) => (node: HTMLElement | null) => {
    if (node) nodes.current.set(key, node);
    else nodes.current.delete(key);
  };
  const byId = new Map(comments.map((c) => [c.id, c]));
  return (
    <aside
      aria-label={t("notes.margin")}
      className="relative flex h-full w-full flex-col overflow-hidden border-l border-border bg-surface-secondary/40"
    >
      <div className="flex h-[26px] shrink-0 items-center gap-2 border-b border-border bg-background px-2 text-[11px] text-muted">
        <ChatCircleTextIcon className="size-3.5" />
        <span>{t("notes.openCount", { count: open.length })}</span>
        {others.length > 0 && (
          <button
            type="button"
            aria-expanded={showOthers}
            onClick={() => setShowOthers((v) => !v)}
            className="ml-1 inline-flex items-center gap-0.5 hover:text-foreground"
          >
            {t("notes.othersCount", { count: others.length })}
            <CaretDownIcon className={`size-3 ${showOthers ? "rotate-180" : ""}`} />
          </button>
        )}
        <button
          type="button"
          aria-label={t("notes.toggleMargin")}
          title={t("notes.toggleMargin")}
          onClick={onClose}
          className="ml-auto p-0.5 hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div ref={area} className="relative min-h-0 flex-1 overflow-hidden">
        {items.map((item) => {
          const style = { top: tops.get(item.key) ?? 0 };
          if (item.key === "add")
            return (
              <button
                key="add"
                ref={keep("add")}
                type="button"
                style={style}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onAdd}
                className="absolute left-2 inline-flex items-center gap-1 border border-foreground bg-background px-2 py-1 text-xs shadow-sm hover:bg-foreground hover:text-background"
              >
                <ChatCircleTextIcon className="size-3.5" />
                {t("notes.add")}
              </button>
            );
          if (item.key === "draft" && draft)
            return (
              <div key="draft" ref={keep("draft")} style={style} className="absolute inset-x-2">
                <DraftCard ws={ws} draft={draft} setDraft={setDraft} onSubmit={onSubmit} />
              </div>
            );
          const comment = byId.get(item.key);
          if (!comment) return null;
          return (
            <div
              key={item.key}
              ref={keep(item.key)}
              style={style}
              className={`absolute inset-x-2 transition-[top] duration-100 ${active === item.key ? "z-10" : ""}`}
            >
              <ThreadCard
                ws={ws}
                comment={comment}
                active={active === item.key}
                onActivate={() => setActive(item.key)}
              />
            </div>
          );
        })}
        {!items.length && (
          <p className="p-3 text-center text-[11px] text-muted">{t("notes.empty")}</p>
        )}
        {showOthers && (
          <div className="absolute inset-x-0 top-0 z-20 max-h-full space-y-2 overflow-auto border-b border-border bg-background p-2 shadow-lg">
            {others.map((c) => (
              <ThreadCard
                key={c.id}
                ws={ws}
                comment={c}
                heading={
                  !c.resolved && (
                    <span className="block text-[11px] text-amber-700">
                      {t("notes.unanchored")}
                    </span>
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
