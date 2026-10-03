"use client";
import {
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  XIcon,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ConversationTarget,
  HARNESSES,
  harnessLabel,
  isHarnessId,
  STATUS_LABELS,
} from "@/lib/harness/types";
import { useAnnotations } from "@/lib/pdf/annotation-context";
import type { PdfAnnotation } from "@/lib/pdf/annotations";

const ACTIONS: Record<string, string> = {
  created: "保存批注",
  quote_repaired: "恢复选文文字映射",
  applied: "已合并文稿修改",
  reanchored: "更新选区定位",
  edited: "修改批注",
  submitted: "提交 AI · 修改前版本",
  resolved: "已解决 · 修改后版本",
  reopened: "重新打开",
  baseline: "旧批注基线",
};
export function AnnotationManager() {
  const notes = useAnnotations();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetId, setTargetId] = useState("new:codex");
  // biome-ignore lint/correctness/useExhaustiveDependencies: selections belong to one project.
  useEffect(() => {
    setSelected(new Set());
  }, [notes?.project]);
  const target = (): ConversationTarget | null => {
    const tab = notes?.conversations.find((t) => t.id === targetId);
    if (tab) return { backend: tab.backend, tabId: tab.id };
    const backend = targetId.startsWith("new:") ? targetId.slice(4) : null;
    return isHarnessId(backend) ? { backend } : null;
  };
  const dispatch = (ids: string[]) => {
    const destination = target();
    if (destination && notes) void notes.submit(ids, destination);
  };

  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 80, width: 720, maxHeight: 500 });
  const [filter, setFilter] = useState<"all" | "pending" | "resolved">("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [preview, setPreview] = useState<{ hash: string; text: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const isOpen = notes?.open;
  const setOpen = notes?.setOpen;
  const newDraft = notes?.draft;
  useEffect(() => {
    if (newDraft) {
      setPreview(null);
      setEditing(null);
      previewRequest.current++;
    }
  }, [newDraft]);
  useEffect(() => {
    if (!isOpen) {
      setPreview(null);
      setPreviewError(null);
      previewRequest.current++;
    }
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const reposition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(800, window.innerWidth - 24);
      const top = rect.bottom + 6;
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top,
        width,
        maxHeight: Math.max(140, Math.min(600, window.innerHeight - top - 16)),
      });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const observer = new ResizeObserver(reposition);
    if (buttonRef.current) observer.observe(buttonRef.current);
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !buttonRef.current?.contains(event.target) &&
        !panelRef.current?.contains(event.target)
      )
        setOpen?.(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (preview) {
          setPreview(null);
          previewRequest.current++;
        } else {
          setOpen?.(false);
          buttonRef.current?.focus();
        }
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      observer.disconnect();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, setOpen, preview]);
  if (!notes) return null;
  const pending = notes.items.filter((note) => !note.resolved);
  const resolved = notes.items.filter((note) => note.resolved);
  const filtered = notes.items
    .filter(
      (note) =>
        (filter === "all" || (filter === "resolved") === note.resolved) &&
        `${note.comment} ${note.quote} ${note.pdf} ${note.source?.file ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (b.events?.at(-1)?.timestamp ?? b.createdAt) - (a.events?.at(-1)?.timestamp ?? a.createdAt),
    );
  const toggle = (id: string) => {
    const next = new Set(notes.expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    notes.setExpanded(next);
  };
  const viewVersion = async (hash: string) => {
    const request = ++previewRequest.current;
    setPreview({ hash, text: "正在读取版本…" });
    setPreviewError(null);
    try {
      const text = await invoke<string>("git_snapshot_diff", { project: notes.project, hash });
      if (request === previewRequest.current) setPreview({ hash, text });
    } catch (cause) {
      if (request === previewRequest.current) setPreviewError(String(cause));
    }
  };
  const statusIcon = (note: PdfAnnotation) =>
    note.resolved ? (
      <CheckCircleIcon weight="fill" className="size-4 shrink-0 text-emerald-600" />
    ) : note.submittedTo ? (
      <ClockIcon className="size-4 shrink-0 text-orange-600" />
    ) : (
      <CircleIcon className="size-4 shrink-0 text-muted" />
    );
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={notes.open}
        aria-controls="writer-annotation-panel"
        onClick={() => notes.setOpen(!notes.open)}
        title="批注历史与处理状态"
        className={`inline-flex shrink-0 items-center gap-1.5 border px-2 py-1 ${notes.error ? "border-red-500" : "border-border"}`}
      >
        <span>批注 {pending.length}</span>
        {resolved.length > 0 && (
          <span className="flex items-center gap-1 text-emerald-600">
            <CheckCircleIcon weight="fill" className="size-3.5" />
            {resolved.length}
          </span>
        )}
        {notes.draft && <span className="text-orange-600">草稿</span>}
        <CaretDownIcon
          className={`size-3 transition-transform ${notes.open ? "rotate-180" : ""}`}
        />
      </button>
      {notes.open &&
        createPortal(
          <div
            ref={panelRef}
            id="writer-annotation-panel"
            role="dialog"
            aria-label="批注历史与处理状态"
            style={{ ...position, position: "fixed" }}
            className="z-[160] flex flex-col overflow-hidden border border-border bg-background text-xs text-foreground shadow-xl"
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
              <strong>批注管理</strong>
              <span className="mr-auto text-muted">
                待处理 {pending.length} · 已解决 {resolved.length}
              </span>
              <button
                type="button"
                aria-label="收起全部批注面板"
                title="收起批注面板"
                onClick={() => notes.setOpen(false)}
                className="p-1 hover:text-accent"
              >
                <XIcon className="size-4" />
              </button>
            </div>
            {notes.error && (
              <p role="alert" className="shrink-0 border-b border-border px-3 py-2 text-red-600">
                {notes.error}
              </p>
            )}
            {preview ? (
              <>
                <div className="flex shrink-0 items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPreview(null);
                      previewRequest.current++;
                    }}
                    className="border border-border px-2 py-1"
                  >
                    返回批注
                  </button>
                  <code>{preview.hash.slice(0, 10)}</code>
                </div>
                {previewError && (
                  <p role="alert" className="px-3 text-red-600">
                    {previewError}
                  </p>
                )}
                <pre className="min-h-0 overflow-auto border-t border-border p-3 font-mono text-[11px] leading-relaxed">
                  {preview.text}
                </pre>
              </>
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                  {(
                    [
                      ["all", `全部 ${notes.items.length}`],
                      ["pending", `待处理 ${pending.length}`],
                      ["resolved", `已解决 ${resolved.length}`],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                      className={`border px-2 py-1 ${filter === value ? "border-foreground bg-foreground text-background" : "border-border"}`}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => notes.setExpanded(new Set(filtered.map((note) => note.id)))}
                    className="px-1 py-1"
                  >
                    全部展开
                  </button>
                  <button
                    type="button"
                    onClick={() => notes.setExpanded(new Set())}
                    className="px-1 py-1"
                  >
                    全部折叠
                  </button>
                  <input
                    aria-label="搜索批注"
                    placeholder="搜索批注或选文…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-40 border border-border bg-background px-2 py-1"
                  />
                </div>
                <div className="min-h-0 overflow-y-auto overscroll-contain p-3">
                  {notes.draft && (
                    <section
                      aria-label="新批注"
                      className="mb-3 space-y-2 border border-orange-400 p-3"
                    >
                      <div className="flex justify-between gap-2">
                        <strong>
                          新批注 ·{" "}
                          {notes.draft.kind === "text"
                            ? notes.draft.file
                            : `${notes.draft.pdf} · 第 ${notes.draft.marks[0]?.page} 页`}
                        </strong>
                        <button
                          type="button"
                          disabled={notes.busy}
                          onClick={() => notes.setDraft(null)}
                        >
                          取消草稿
                        </button>
                      </div>
                      <blockquote className="max-h-16 overflow-auto border-l-2 border-orange-400 pl-2 text-muted">
                        {notes.draft.quote}
                      </blockquote>
                      {notes.draft.kind !== "text" && (
                        <details>
                          <summary className="cursor-pointer text-xs text-muted">
                            核对／修正选中文字
                          </summary>
                          <textarea
                            aria-label="批注选中文字"
                            value={notes.draft.quote}
                            onChange={(event) =>
                              notes.setDraft(
                                notes.draft ? { ...notes.draft, quote: event.target.value } : null,
                              )
                            }
                            className="mt-2 max-h-40 min-h-16 w-full resize-y border border-border bg-background p-2 text-xs"
                          />
                        </details>
                      )}
                      <textarea
                        aria-label="批注修改要求"
                        value={notes.draft.comment}
                        onChange={(e) =>
                          notes.setDraft(
                            notes.draft ? { ...notes.draft, comment: e.target.value } : null,
                          )
                        }
                        rows={3}
                        placeholder="填写需要修改的内容…"
                        className="w-full resize-y border border-border bg-background p-2"
                      />
                      <button
                        type="button"
                        disabled={notes.busy || !notes.draft.comment.trim()}
                        onClick={() => void notes.saveDraft()}
                        className="border border-foreground bg-foreground px-3 py-1.5 text-background disabled:opacity-40"
                      >
                        {notes.busy ? "保存批注与 Git 版本…" : "保存批注并记录 Git"}
                      </button>
                    </section>
                  )}
                  {!filtered.length && (
                    <p className="py-5 text-center text-muted">
                      {notes.items.length
                        ? "没有符合条件的批注。"
                        : "在 PDF 中拖选，或在文本编辑器中选中文字后点击“添加批注”。"}
                    </p>
                  )}
                  {filtered.map((note) => (
                    <article
                      key={note.id}
                      className={`mb-2 border ${note.resolved ? "border-emerald-200" : "border-border"}`}
                    >
                      <div className="flex items-start">
                        <input
                          type="checkbox"
                          aria-label={`选择批注：${note.comment}`}
                          disabled={note.resolved}
                          className="ml-3 mt-3 shrink-0"
                          checked={selected.has(note.id)}
                          onChange={(event) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(note.id);
                              else next.delete(note.id);
                              return next;
                            })
                          }
                        />
                        <button
                          type="button"
                          aria-expanded={notes.expanded.has(note.id)}
                          onClick={() => toggle(note.id)}
                          className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent-hover"
                        >
                          {notes.expanded.has(note.id) ? (
                            <CaretDownIcon className="mt-0.5 size-3 shrink-0" />
                          ) : (
                            <CaretRightIcon className="mt-0.5 size-3 shrink-0" />
                          )}
                          {statusIcon(note)}
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <strong className={note.resolved ? "text-emerald-700" : ""}>
                                {note.resolved
                                  ? "已解决"
                                  : note.submittedTo
                                    ? `已提交 ${harnessLabel(note.submittedTo)}`
                                    : "待处理"}
                              </strong>
                              <span className="text-muted">
                                {note.kind === "text"
                                  ? `${note.source?.file || note.anchor?.file} · 文本选区`
                                  : `${note.pdf} · 第 ${note.marks[0]?.page} 页`}
                              </span>
                            </span>
                            <span className="mt-1 block truncate">{note.comment}</span>
                          </span>
                        </button>
                      </div>
                      {notes.expanded.has(note.id) && (
                        <div className="space-y-2 border-t border-border px-3 py-3">
                          <blockquote className="max-h-24 overflow-auto border-l-2 border-border pl-2 text-muted">
                            {note.quote}
                          </blockquote>
                          {editing === note.id ? (
                            <div className="space-y-2">
                              <textarea
                                aria-label="编辑 PDF 批注"
                                rows={3}
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                                className="w-full resize-y border border-border bg-background p-2"
                              />
                              <button
                                type="button"
                                disabled={notes.busy || !comment.trim()}
                                onClick={() =>
                                  void notes.update(note.id, { comment }).then((ok) => {
                                    if (ok) setEditing(null);
                                  })
                                }
                                className="border border-border px-2 py-1"
                              >
                                保存修改并记录 Git
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditing(null)}
                                className="ml-2 px-2"
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                            <p className="whitespace-pre-wrap break-words">{note.comment}</p>
                          )}
                          <div className="flex flex-wrap gap-x-3 gap-y-2">
                            <button
                              type="button"
                              onClick={() =>
                                note.kind === "text" ? notes.showSource(note) : notes.showPdf(note)
                              }
                            >
                              定位原文
                            </button>
                            <button
                              type="button"
                              disabled={!note.source}
                              onClick={() => notes.showSource(note)}
                              className="disabled:text-muted"
                            >
                              {note.source
                                ? `${note.source.file}:L${note.source.line}–${note.source.endLine}`
                                : "源码待核对"}
                            </button>
                            <button
                              type="button"
                              disabled={notes.busy}
                              onClick={() => {
                                setEditing(note.id);
                                setComment(note.comment);
                              }}
                            >
                              编辑批注
                            </button>
                            <button
                              type="button"
                              disabled={notes.busy}
                              onClick={() =>
                                void notes.update(note.id, { resolved: !note.resolved })
                              }
                              className={note.resolved ? "" : "text-emerald-700"}
                            >
                              {note.resolved ? "重新打开" : "标为已解决"}
                            </button>
                            {!note.resolved && (
                              <button
                                type="button"
                                disabled={notes.busy || !target()}
                                onClick={() => dispatch([note.id])}
                              >
                                交给下方所选对话
                              </button>
                            )}
                          </div>
                          {note.resolution && (
                            <p className="border-l-2 border-emerald-500 pl-2 leading-relaxed text-foreground">
                              {note.resolution}
                            </p>
                          )}
                          <details>
                            <summary className="cursor-pointer text-muted">
                              版本与处理历史 · {note.events?.length ?? 0}
                            </summary>
                            <div className="mt-2 space-y-2">
                              {note.events
                                ?.slice()
                                .reverse()
                                .map((event) => (
                                  <div key={event.id} className="border-t border-border pt-2">
                                    <div className="flex flex-wrap gap-2">
                                      <span>{ACTIONS[event.action] || event.action}</span>
                                      <time className="text-muted">
                                        {new Date(event.timestamp).toLocaleString()}
                                      </time>
                                      {event.gitHash ? (
                                        <button
                                          type="button"
                                          onClick={() => void viewVersion(event.gitHash as string)}
                                          className="font-mono underline"
                                        >
                                          Git {event.gitHash.slice(0, 7)}
                                        </button>
                                      ) : (
                                        <span className="text-red-600">未找到 Git 记录</span>
                                      )}
                                    </div>
                                    {event.resolution && (
                                      <p className="mt-1 whitespace-pre-wrap text-muted">
                                        {event.resolution}
                                      </p>
                                    )}
                                    {event.action === "edited" && (
                                      <p className="mt-1 whitespace-pre-wrap text-muted">
                                        {event.comment}
                                      </p>
                                    )}
                                  </div>
                                ))}
                            </div>
                          </details>
                          <p className="text-[11px] text-muted">{note.mappingNote}</p>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2">
                  <span className="mr-auto text-muted">
                    每次保存／解决批注立即记录本地 Git 版本
                  </span>
                  <label className="flex min-w-0 items-center gap-2">
                    目标
                    <select
                      aria-label="批注处理对话"
                      value={targetId}
                      onChange={(event) => setTargetId(event.target.value)}
                      className="max-w-72 border border-border bg-background px-2 py-1"
                    >
                      <optgroup label="新建对话">
                        {HARNESSES.map((h) => (
                          <option key={h.id} value={`new:${h.id}`}>
                            新 {h.label} 对话
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="已打开的对话">
                        {notes.conversations.map((tab) => (
                          <option key={tab.id} value={tab.id}>
                            {harnessLabel(tab.backend)} · {tab.title} · {STATUS_LABELS[tab.status]}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="border border-border px-2 py-1"
                    onClick={() =>
                      setSelected(new Set(filtered.filter((n) => !n.resolved).map((n) => n.id)))
                    }
                  >
                    选择可见待处理
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1"
                    onClick={() => setSelected(new Set())}
                  >
                    清空选择
                  </button>
                  <button
                    type="button"
                    className="border border-foreground bg-foreground px-2 py-1 text-background disabled:opacity-40"
                    disabled={
                      notes.busy ||
                      !target() ||
                      !notes.items.some((n) => !n.resolved && selected.has(n.id))
                    }
                    onClick={() =>
                      dispatch(
                        notes.items
                          .filter((n) => !n.resolved && selected.has(n.id))
                          .map((n) => n.id),
                      )
                    }
                  >
                    提交所选 {notes.items.filter((n) => !n.resolved && selected.has(n.id)).length}{" "}
                    条
                  </button>
                  <button
                    type="button"
                    className="border border-border px-2 py-1 disabled:opacity-40"
                    disabled={notes.busy || !target() || !pending.length}
                    onClick={() => dispatch(pending.map((n) => n.id))}
                  >
                    提交全部待处理
                  </button>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
