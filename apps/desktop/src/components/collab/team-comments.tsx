"use client";
/**
 * The team's comments on a linked folder, in the status bar beside the local annotations:
 * every thread from the collaboration server with replies, resolving and editing, and a jump
 * to the commented line.
 */
import { CommentThread } from "@lmms-lab/workbench";
import { CaretDownIcon, CrosshairIcon, UsersThreeIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTeamComments } from "@/lib/collab/team-comments";
import { useI18n } from "@/lib/i18n";

export function TeamComments({ onOpenFile }: { onOpenFile: (reference: string) => void }) {
  const { t } = useI18n();
  const team = useTeamComments();
  const button = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<"open" | "resolved">("open"),
    [position, setPosition] = useState({ left: 12, top: 80, width: 720, maxHeight: 500 });
  const open = !!team?.open;
  const setOpen = team?.setOpen;
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(760, window.innerWidth - 24);
      const top = rect.bottom + 6;
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top,
        width,
        maxHeight: Math.max(160, Math.min(620, window.innerHeight - top - 16)),
      });
    };
    place();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen?.(false);
    };
    window.addEventListener("resize", place);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);
  // A thread chosen from its highlight in the editor shows among the open ones.
  useEffect(() => {
    if (team?.focus) setFilter("open");
  }, [team?.focus]);
  if (!team?.link) return null;
  const pending = team.comments.filter((c) => !c.resolved),
    resolved = team.comments.filter((c) => c.resolved);
  const shown = filter === "open" ? pending : resolved;
  const editor = team.role === "owner" || team.role === "editor";
  const canComment = team.role !== null && team.role !== "viewer";
  const act = (method: string, path: string, body?: unknown) =>
    void team.act(method, path, body).catch(() => {});
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        onClick={() => team.setOpen(!open)}
        title={t("team.commentsTitle", { name: team.link.name })}
        className={`inline-flex shrink-0 items-center gap-1.5 border px-2 py-1 ${team.error ? "border-red-500" : "border-border"}`}
      >
        <UsersThreeIcon className="size-3.5" />
        <span>{t("team.commentsCount", { count: pending.length })}</span>
        <CaretDownIcon className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open &&
        createPortal(
          <div
            role="dialog"
            aria-label={t("team.commentsTitle", { name: team.link.name })}
            style={{ ...position, position: "fixed" }}
            className="z-[160] flex flex-col overflow-hidden border border-border bg-background text-xs text-foreground shadow-xl"
          >
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <strong>{t("team.commentsTitle", { name: team.link.name })}</strong>
              <span className="mr-auto text-muted">{t("team.lead")}</span>
              <button
                type="button"
                aria-label={t("team.close")}
                onClick={() => team.setOpen(false)}
                className="p-1 hover:text-accent"
              >
                <XIcon className="size-4" />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              {(
                [
                  ["open", t("team.open", { count: pending.length })],
                  ["resolved", t("team.resolved", { count: resolved.length })],
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
              <button
                type="button"
                className="ml-auto border border-border px-2 py-1 disabled:opacity-40"
                disabled={team.busy}
                onClick={() => void team.refresh()}
              >
                {t("team.refresh")}
              </button>
            </div>
            {team.error && (
              <p role="alert" className="shrink-0 border-b border-border px-3 py-2 text-red-600">
                {team.error}
              </p>
            )}
            <div className="min-h-0 space-y-2 overflow-y-auto overscroll-contain p-3">
              {!shown.length && <p className="py-5 text-center text-muted">{t("team.none")}</p>}
              {shown.map((c) => (
                <CommentThread
                  key={c.id}
                  comment={c}
                  me={team.me ?? ""}
                  canComment={canComment}
                  canResolve={editor}
                  canDeleteAny={team.role === "owner"}
                  busy={team.busy}
                  active={team.focus === c.id}
                  onActivate={() => team.setFocus(c.id)}
                  heading={
                    <div className="flex items-center gap-2 text-[11px] text-muted">
                      <span className="truncate">
                        {c.path ?? ""}
                        {c.line ? `:${c.line}` : ` · ${t("team.detached")}`}
                      </span>
                      {c.path && c.line && (
                        <button
                          type="button"
                          className="ml-auto inline-flex shrink-0 items-center gap-1 hover:text-foreground"
                          onClick={() => {
                            onOpenFile(`${c.path}:${c.line}`);
                            team.setOpen(false);
                          }}
                        >
                          <CrosshairIcon className="size-3.5" />
                          {t("team.locate")}
                        </button>
                      )}
                    </div>
                  }
                  onResolve={(value) => act("PATCH", `/comments/${c.id}`, { resolved: value })}
                  onEdit={(body) => act("PATCH", `/comments/${c.id}`, { body })}
                  onDelete={() => act("DELETE", `/comments/${c.id}`, {})}
                  onReply={(body) => team.act("POST", `/comments/${c.id}/reply`, { body })}
                  onEditReply={(id, body) => act("PATCH", `/replies/${id}`, { body })}
                  onDeleteReply={(id) => act("DELETE", `/replies/${id}`, {})}
                />
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
