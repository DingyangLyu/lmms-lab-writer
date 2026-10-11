/**
 * The sticky note opened from beside the text or the PDF: the comments on that line, or the
 * comment being written, and which AI conversation to hand them to. It sits next to its note,
 * follows it while scrolling, and closes with Escape, a click elsewhere or its note again.
 */
import { NoteIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Comment } from "../../shared/api";
import { useI18n } from "../i18n";
import { AiTargetSelect } from "./ai-target";
import { commentsTask } from "./ai-tasks";
import { noteWhere } from "./comments-panel";
import type { WorkspaceContext } from "./context";
import type { CommentDraft } from "./notes";
import { DraftCard } from "./review-margin";
import { ThreadCard } from "./thread-card";
import { Btn, onTop } from "./ui";

/** Which note is open: comments on one line, or the draft (from the text or the PDF). */
export type BubbleState =
  | { kind: "notes"; ids: string[]; where: "editor" | "pdf" }
  | { kind: "draft"; where: "editor" | "pdf"; rect?: DOMRect | null };

/** The same note again closes it; another one replaces it. */
export const toggleBubble = (current: BubbleState | null, next: BubbleState) =>
  current &&
  current.kind === next.kind &&
  current.where === next.where &&
  (current.kind === "draft" || current.ids.join() === (next as { ids: string[] }).ids.join())
    ? null
    : next;

/** The note on screen the bubble belongs to; null while it is scrolled away. */
function anchorRect(state: BubbleState): DOMRect | null {
  let element: Element | null = null;
  if (state.kind === "draft") {
    if (state.where === "pdf") return state.rect ?? null;
    element = document.querySelector(".cm-note-marker[data-note-draft]");
  } else {
    const id = state.ids[0] ?? "";
    element = document.querySelector(
      state.where === "pdf"
        ? `[data-pdf-note-ids~="${CSS.escape(id)}"]`
        : `.cm-note-marker[data-note-ids~="${CSS.escape(id)}"]`,
    );
  }
  const rect = element?.getBoundingClientRect();
  return rect && rect.height > 0 ? rect : null;
}

export function NoteBubble({
  ws,
  state,
  comments,
  draft,
  setDraft,
  onSubmit,
  onClose,
}: {
  ws: WorkspaceContext;
  state: BubbleState;
  comments: Comment[];
  draft: CommentDraft | null;
  setDraft: (draft: CommentDraft | null) => void;
  /** Posts the draft; `true` also hands the new comment to the chosen AI conversation. */
  onSubmit: (andAsk?: boolean) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(
    null,
  );
  // Follows the note: scrolling, resizing, and the editor redrawing its gutter.
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = anchorRect(state);
        if (!rect || rect.bottom < 48 || rect.top > window.innerHeight) {
          setPosition(null);
          return;
        }
        const width = Math.min(340, window.innerWidth - 16);
        const height = panel.current?.offsetHeight ?? 260;
        const beside = rect.right + 8;
        const left =
          beside + width <= window.innerWidth - 8 ? beside : Math.max(8, rect.left - 8 - width);
        const top = Math.max(56, Math.min(rect.top - 10, window.innerHeight - height - 8));
        setPosition((old) =>
          old && old.left === left && old.top === top && old.width === width
            ? old
            : { left, top, width },
        );
      });
    };
    place();
    const timer = setInterval(place, 400);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      observer.disconnect();
    };
  }, [state]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        !target ||
        panel.current?.contains(target) ||
        target.closest?.(".cm-note-marker, [data-pdf-note-ids]")
      )
        return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const notes =
    state.kind === "notes" ? comments.filter((c) => state.ids.includes(c.id) && !c.resolved) : [];
  // Its comments were resolved or deleted, or the draft was posted elsewhere.
  useEffect(() => {
    if ((state.kind === "notes" && !notes.length) || (state.kind === "draft" && !draft)) onClose();
  }, [state.kind, notes.length, draft, onClose]);
  const target = ws.askAi && (
    <AiTargetSelect
      value={ws.ai.choice}
      onChange={ws.ai.setChoice}
      conversations={ws.ai.conversations}
      className="min-w-0 flex-1"
    />
  );
  return onTop(
    <div
      ref={panel}
      role="dialog"
      aria-label={state.kind === "draft" ? t("notes.draftNote") : t("notes.column")}
      style={{
        position: "fixed",
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        width: position?.width ?? 340,
        visibility: position ? "visible" : "hidden",
      }}
      className="z-[160] flex max-h-[min(70vh,560px)] flex-col border border-amber-300 border-t-4 border-t-amber-400 bg-[#fffdf3] text-xs text-foreground shadow-xl"
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-amber-200 px-2.5 py-1.5">
        <NoteIcon className="size-4 shrink-0 text-amber-500" weight="fill" aria-hidden="true" />
        <strong className="min-w-0 flex-1 truncate">
          {state.kind === "draft"
            ? t("notes.draftNote")
            : notes[0]
              ? noteWhere(ws, notes[0], t)
              : t("notes.column")}
        </strong>
        <button
          type="button"
          aria-label={t("notes.close")}
          title={t("notes.close")}
          onClick={onClose}
          className="p-0.5 hover:text-accent"
        >
          <XIcon className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2">
        {state.kind === "draft" && draft && (
          <DraftCard ws={ws} draft={draft} setDraft={setDraft} onSubmit={() => onSubmit()} />
        )}
        {notes.map((c) => (
          <ThreadCard key={c.id} ws={ws} comment={c} active noAi />
        ))}
      </div>
      {target && (state.kind === "draft" ? !!draft : notes.length > 0) && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-amber-200 px-2.5 py-2">
          {target}
          {state.kind === "draft" ? (
            <Btn
              disabled={
                ws.busy ||
                !ws.canComment ||
                !draft?.body.trim() ||
                (!!draft?.start && ws.status !== "saved")
              }
              title={t("comments.askAiTitle")}
              onClick={() => onSubmit(true)}
            >
              <RobotIcon className="size-3.5" aria-hidden="true" />
              {t("notes.postAndAsk")}
            </Btn>
          ) : (
            <Btn
              tone="solid"
              title={t("comments.askAiTitle")}
              onClick={() =>
                ws.askAi?.(
                  commentsTask(notes, ws.files, locale),
                  notes.map((c) => c.id),
                )
              }
            >
              <RobotIcon className="size-3.5" aria-hidden="true" />
              {notes.length > 1
                ? t("notes.sendSelected", { count: notes.length })
                : t("comments.askAi")}
            </Btn>
          )}
        </footer>
      )}
    </div>,
  );
}
