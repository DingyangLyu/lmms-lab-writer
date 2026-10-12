/**
 * Pieces of the workbench's one header row: when the project's last version was saved, the
 * compile button with its settings, and the menu that holds what is used less often.
 */
import {
  CaretDownIcon,
  ClockCounterClockwiseIcon,
  DesktopIcon,
  DownloadIcon,
  DownloadSimpleIcon,
  GitBranchIcon,
  ListIcon,
  PlayCircleIcon,
  SquaresFourIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Engine, Member, PublicUser, Role, Snapshot } from "../../shared/api";
import { Avatar } from "../avatar";
import { ago } from "../dashboard";
import { FONT_SIZES, useEditorSettings } from "../editor-settings";
import { useSnapshotLabel } from "../history";
import { useI18n } from "../i18n";
import { roleKey } from "../labels";
import { addWord, onWordsChanged, ownWords, removeWord, syncWords } from "../spell/client";
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

const ENGINE_NAMES: Record<Engine, string> = {
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
};
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
              value={b.engineSetting}
              onChange={(e) => b.setEngine(e.target.value as Engine | "auto")}
            >
              <option value="auto">
                {t("build.engineAuto", { engine: ENGINE_NAMES[b.chosenEngine] })}
              </option>
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

/**
 * The account and what is used least: all projects, export, the desktop app. References, word
 * count, AI changes and settings live in the left rail.
 */
export function WorkspaceMenu({
  user,
  role,
  exportHref,
  desktopHref,
  onProjects,
  onShare,
  onGit,
}: {
  user: PublicUser;
  role: Role;
  exportHref: string;
  desktopHref: string;
  onProjects: () => void;
  /** Phones have no room for the Share button beside the menu. */
  onShare: () => void;
  onGit: () => void;
}) {
  const { t } = useI18n();
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
          {entry(<GitBranchIcon className={icon} />, t("shell.git"), onGit)}
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
          {/* A new tab, so the project stays open here. */}
          <a
            href="/?desktop"
            target="_blank"
            rel="noopener"
            className={item}
            onClick={() => setOpen(false)}
          >
            <DownloadIcon className={icon} />
            {t("desktop.title")}
          </a>
        </nav>
      </Popover>
    </>
  );
}

/** The rail's settings: the editor (this browser) and the page's language. */
export function SettingsPanel() {
  const { t, locale, setLocale } = useI18n();
  return (
    <section aria-label={t("settings.title")} className="flex min-h-0 flex-1 flex-col text-xs">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <strong>{t("settings.title")}</strong>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
            {t("settings.editor")}
          </h3>
          <EditorSettingsSection />
          <p className="mt-2 leading-relaxed text-muted">{t("settings.spellHint")}</p>
        </div>
        <PersonalDictionary />
        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
            {t("settings.language")}
          </h3>
          <div className="flex gap-2">
            {(["zh", "en"] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                aria-pressed={locale === lang}
                onClick={() => setLocale(lang)}
                className={`rounded-md border px-3 py-1 ${locale === lang ? "border-foreground bg-foreground text-background" : "border-border hover:bg-accent-hover"}`}
              >
                {lang === "zh" ? "中文" : "English"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** The member's spelling dictionary (kept with the account): add and remove words. */
function PersonalDictionary() {
  const { t } = useI18n();
  const [words, setWords] = useState<string[]>(ownWords);
  const [adding, setAdding] = useState("");
  useEffect(() => {
    const stop = onWordsChanged(() => setWords(ownWords()));
    void syncWords();
    return () => {
      stop();
    };
  }, []);
  const add = () => {
    const word = adding.trim();
    if (!word || /\s/.test(word)) return;
    addWord(word);
    setAdding("");
  };
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
        {t("settings.dictionary", { count: words.length })}
      </h3>
      <form
        className="mb-2 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          placeholder={t("settings.addWord")}
          aria-label={t("settings.addWord")}
          maxLength={64}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 focus:border-foreground focus:outline-none"
        />
        <button
          type="submit"
          disabled={!adding.trim()}
          className="rounded-md border border-border px-2 hover:bg-accent-hover disabled:opacity-40"
        >
          {t("settings.add")}
        </button>
      </form>
      {words.length ? (
        <div className="flex flex-wrap gap-1">
          {words.map((word) => (
            <span
              key={word}
              className="pop-in inline-flex items-center gap-1 rounded-full border border-border bg-background py-0.5 pr-1 pl-2"
            >
              {word}
              <button
                type="button"
                aria-label={t("settings.removeWord", { word })}
                title={t("settings.removeWord", { word })}
                onClick={() => removeWord(word)}
                className="rounded-full px-1 text-muted hover:bg-accent-hover hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-muted">{t("settings.noWords")}</p>
      )}
      <p className="mt-2 leading-relaxed text-muted">{t("settings.dictionaryHint")}</p>
    </div>
  );
}

/** Text size, wrapping, line numbers, full-width punctuation marks and spelling, for this browser. */
function EditorSettingsSection() {
  const { t } = useI18n();
  const [settings, change] = useEditorSettings();
  const at = FONT_SIZES.indexOf(settings.fontSize);
  const step = (by: number) => {
    const next = FONT_SIZES[at + by];
    if (next) change({ fontSize: next });
  };
  const box = "border border-border px-1.5 leading-5 hover:bg-accent-hover disabled:opacity-40";
  const toggle = (label: string, checked: boolean, set: (on: boolean) => void) => (
    <label className="flex cursor-pointer items-center gap-2 py-0.5">
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="flex-1">{t("shell.editorSettings")}</span>
        <span className="text-muted">{t("shell.fontSize")}</span>
        <button
          type="button"
          className={box}
          aria-label={t("shell.smaller")}
          disabled={at <= 0}
          onClick={() => step(-1)}
        >
          −
        </button>
        <span className="w-6 text-center tabular-nums">{settings.fontSize}</span>
        <button
          type="button"
          className={box}
          aria-label={t("shell.larger")}
          disabled={at >= FONT_SIZES.length - 1}
          onClick={() => step(1)}
        >
          +
        </button>
      </div>
      {toggle(t("shell.wordWrap"), settings.wordWrap !== "off", (on) =>
        change({ wordWrap: on ? "on" : "off" }),
      )}
      {toggle(t("shell.lineNumbers"), settings.lineNumbers !== "off", (on) =>
        change({ lineNumbers: on ? "on" : "off" }),
      )}
      {toggle(t("shell.markFullWidth"), settings.highlightAmbiguousUnicode, (on) =>
        change({ highlightAmbiguousUnicode: on }),
      )}
      {toggle(t("shell.spellcheck"), settings.spellcheck, (on) => change({ spellcheck: on }))}
    </div>
  );
}
