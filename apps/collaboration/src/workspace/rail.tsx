/**
 * The narrow bar of icons at the left of a project, as in Overleaf's editor: each opens its
 * panel beside it (files, search, comments, versions, messages, settings) or a dialog
 * (references, word count, AI changes to review). A second click on the open one closes it.
 */
import {
  BellIcon,
  BooksIcon,
  ChatsCircleIcon,
  ClockCounterClockwiseIcon,
  FilesIcon,
  GearSixIcon,
  GitDiffIcon,
  MagnifyingGlassIcon,
  TextAaIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useI18n } from "../i18n";

export type RailPanel = "files" | "search" | "comments" | "history" | "inbox" | "settings";

function RailButton({
  label,
  active,
  badge,
  tone = "amber",
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  badge?: number;
  tone?: "amber" | "sky" | "orange";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={badge ? `${label} (${badge})` : label}
      aria-pressed={active}
      onClick={onClick}
      className={`group relative flex size-9 shrink-0 items-center justify-center rounded-lg transition-all duration-150 active:scale-95 ${active ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted hover:bg-accent-hover hover:text-foreground"}`}
    >
      {active && (
        <span
          aria-hidden="true"
          className="slide-in-left absolute top-2 -left-[5px] h-5 w-[3px] rounded-full bg-foreground"
        />
      )}
      {children}
      {!!badge && (
        <span
          className={`pop-in absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white ${tone === "sky" ? "bg-sky-500" : tone === "orange" ? "bg-orange-600" : "bg-amber-500"}`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      <span
        role="tooltip"
        className="pointer-events-none absolute top-1/2 left-full z-[60] ml-2 -translate-x-1 -translate-y-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[11px] text-background opacity-0 shadow-md transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
      >
        {label}
      </span>
    </button>
  );
}

export function Rail({
  panel,
  onPanel,
  openComments,
  unread,
  pendingReview,
  onReferences,
  onWordCount,
  onReview,
}: {
  /** The panel open beside the rail, if any. */
  panel: RailPanel | null;
  onPanel: (panel: RailPanel) => void;
  openComments: number;
  unread: number;
  pendingReview: number;
  onReferences: () => void;
  onWordCount: () => void;
  onReview: () => void;
}) {
  const { t } = useI18n();
  const icon = "size-[19px]";
  const item = (id: RailPanel, label: string, glyph: ReactNode, badge?: number, tone?: "sky") => (
    <RailButton
      label={label}
      active={panel === id}
      badge={badge}
      tone={tone}
      onClick={() => onPanel(id)}
    >
      {glyph}
    </RailButton>
  );
  return (
    <nav
      aria-label={t("rail.label")}
      className="flex w-12 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-surface-secondary/70 py-2"
    >
      {item("files", t("rail.files"), <FilesIcon className={icon} />)}
      {item("search", t("rail.search"), <MagnifyingGlassIcon className={icon} />)}
      {item("comments", t("rail.comments"), <ChatsCircleIcon className={icon} />, openComments)}
      {item("history", t("rail.history"), <ClockCounterClockwiseIcon className={icon} />)}
      <span className="my-1 h-px w-6 bg-border" aria-hidden="true" />
      <RailButton label={t("rail.references")} onClick={onReferences}>
        <BooksIcon className={icon} />
      </RailButton>
      <RailButton label={t("rail.wordCount")} onClick={onWordCount}>
        <TextAaIcon className={icon} />
      </RailButton>
      {pendingReview > 0 && (
        <RailButton label={t("rail.review")} badge={pendingReview} tone="orange" onClick={onReview}>
          <GitDiffIcon className={icon} />
        </RailButton>
      )}
      <span className="flex-1" />
      {item("inbox", t("rail.inbox"), <BellIcon className={icon} />, unread, "sky")}
      {item("settings", t("rail.settings"), <GearSixIcon className={icon} />)}
    </nav>
  );
}
