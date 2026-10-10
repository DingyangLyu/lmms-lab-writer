/**
 * Pieces of the workbench's one header row: when the project's last version was saved, the
 * compile button with its settings, and the menu that holds what is used less often.
 */
import {
  BooksIcon,
  CaretDownIcon,
  ClockCounterClockwiseIcon,
  DesktopIcon,
  DownloadSimpleIcon,
  GitDiffIcon,
  ListIcon,
  PlayCircleIcon,
  SquaresFourIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Engine, Member, PublicUser, Role, Snapshot } from "../../shared/api";
import { Avatar } from "../avatar";
import { ago } from "../dashboard";
import { useSnapshotLabel } from "../history";
import { useI18n } from "../i18n";
import { roleKey } from "../labels";
import type { BuildState } from "./build";
import { Popover, Select } from "./ui";

/** The latest saved version, "3 minutes ago"; clicking it opens the History tab. */
export function VersionStatus({
  snapshots,
  members,
  onOpen,
}: {
  /** Newest first, as the server lists them. */
  snapshots: Snapshot[];
  members: Member[];
  onOpen: () => void;
}) {
  const { t, locale } = useI18n();
  const snapshotLabel = useSnapshotLabel();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const last = snapshots[0];
  const who = last && members.find((m) => m.id === last.author)?.username;
  const title = last
    ? t("shell.versionTitle", {
        detail: [
          snapshotLabel(last.label),
          new Date(last.created).toLocaleString(locale === "zh" ? "zh-CN" : "en"),
          who,
        ]
          .filter(Boolean)
          .join(" · "),
      })
    : t("shell.noVersionTitle");
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className="flex h-8 shrink-0 items-center gap-1.5 px-1.5 text-xs text-muted hover:bg-accent-hover hover:text-foreground"
    >
      <ClockCounterClockwiseIcon className="size-4" aria-hidden="true" />
      <span className="sr-only xl:not-sr-only">
        {last
          ? t("shell.versionAgo", { time: ago(last.created, locale, t("dash.justNow"), now) })
          : t("shell.noVersion")}
      </span>
    </button>
  );
}

/** Compile, with the main file and the engine one click away (Overleaf's caret beside it). */
export function CompileButton({ b, disabled }: { b: BuildState; disabled: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const id = useId();
  const cell = "flex h-8 items-center border border-foreground bg-foreground text-background";
  return (
    <>
      <div ref={anchor} className="flex shrink-0">
        <button
          type="button"
          title={b.compiling ? t("build.compiling") : t("shell.compileShortcut")}
          aria-label={b.compiling ? t("build.compiling") : t("shell.compile")}
          disabled={disabled}
          onClick={b.compile}
          className={`${cell} gap-1.5 px-2 text-xs hover:opacity-90 disabled:opacity-40 ${b.compiling ? "animate-pulse" : ""}`}
        >
          <PlayCircleIcon className="size-4" weight="fill" aria-hidden="true" />
          <span className="hidden lg:inline">
            {b.compiling ? t("build.compiling") : t("shell.compile")}
          </span>
        </button>
        <button
          type="button"
          title={t("shell.compileSettings")}
          aria-label={t("shell.compileSettings")}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`${cell} w-6 justify-center border-l-background/30 hover:opacity-90`}
        >
          <CaretDownIcon className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={t("shell.compileSettings")}
        width={280}
        align="end"
      >
        <div className="flex flex-col gap-3 p-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-main`} className="text-muted">
              {t("build.main")}
            </label>
            <Select
              id={`${id}-main`}
              value={b.chosenMain}
              onChange={(e) => b.setMain(e.target.value)}
            >
              {b.texFiles.map((f) => (
                <option key={f.id} value={f.path}>
                  {f.path}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-engine`} className="text-muted">
              {t("build.engine")}
            </label>
            <Select
              id={`${id}-engine`}
              value={b.chosenEngine}
              onChange={(e) => b.setEngine(e.target.value as Engine)}
            >
              <option value="pdflatex">pdfLaTeX</option>
              <option value="xelatex">XeLaTeX</option>
              <option value="lualatex">LuaLaTeX</option>
            </Select>
          </div>
        </div>
      </Popover>
    </>
  );
}

/** What the header used to show in a second row: references, review, export, language. */
export function WorkspaceMenu({
  user,
  role,
  pendingReview,
  exportHref,
  desktopHref,
  onProjects,
  onReferences,
  onReview,
  onShare,
}: {
  user: PublicUser;
  role: Role;
  pendingReview: number;
  exportHref: string;
  desktopHref: string;
  onProjects: () => void;
  onReferences: () => void;
  onReview: () => void;
  /** Phones have no room for the Share button beside the menu. */
  onShare: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const item = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-accent-hover";
  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const entry = (icon: ReactNode, label: ReactNode, action: () => void) => (
    <button type="button" className={item} onClick={choose(action)}>
      {icon}
      {label}
    </button>
  );
  const icon = "size-4 shrink-0 text-muted";
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        aria-label={t("shell.menu")}
        title={t("shell.menu")}
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-8 shrink-0 items-center gap-1.5 border border-border px-2 text-xs hover:bg-accent-hover"
      >
        <ListIcon className="size-4" weight="bold" aria-hidden="true" />
        <span className="hidden 2xl:inline">{t("shell.menu")}</span>
        {pendingReview > 0 && (
          <span className="absolute -top-1 -right-1 size-2 bg-orange-600" aria-hidden="true" />
        )}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={t("shell.menu")}
        width={260}
        align="end"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3 py-2.5">
          <Avatar person={user} size={28} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="text-muted">{t(roleKey[role])}</div>
          </div>
        </div>
        <nav className="flex flex-col py-1">
          <button type="button" className={`${item} sm:hidden`} onClick={choose(onShare)}>
            <UsersIcon className={icon} />
            {t("shell.share")}
          </button>
          {entry(<SquaresFourIcon className={icon} />, t("shell.allProjects"), onProjects)}
          {entry(<BooksIcon className={icon} />, t("tab.bibliography"), onReferences)}
          {entry(
            <GitDiffIcon className={icon} />,
            <>
              <span className="flex-1">{t("tab.review")}</span>
              {pendingReview > 0 && (
                <span className="bg-orange-600 px-1.5 text-[10px] text-white">{pendingReview}</span>
              )}
            </>,
            onReview,
          )}
          <a href={exportHref} className={item} onClick={() => setOpen(false)}>
            <DownloadSimpleIcon className={icon} />
            {t("workspace.export")}
          </a>
          <a
            href={desktopHref}
            title={t("workspace.openDesktopTitle")}
            className={item}
            onClick={() => setOpen(false)}
          >
            <DesktopIcon className={icon} />
            {t("workspace.openDesktop")}
          </a>
        </nav>
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="flex-1 text-muted">{t("language.label")}</span>
          {(["zh", "en"] as const).map((lang) => (
            <button
              key={lang}
              type="button"
              aria-pressed={locale === lang}
              onClick={() => setLocale(lang)}
              className={`border px-2 py-0.5 ${locale === lang ? "border-foreground" : "border-border hover:bg-accent-hover"}`}
            >
              {lang === "zh" ? "中文" : "English"}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
