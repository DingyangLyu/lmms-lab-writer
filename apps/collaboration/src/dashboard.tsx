/**
 * The project list, after Overleaf's: a "New project" menu (blank, template, zip upload),
 * filters for owned, shared, archived and trashed projects, search, sortable columns and
 * per-project or bulk actions. Archive and trash only change the signed-in member's list.
 */
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  BookBookmarkIcon,
  CaretDownIcon,
  CopyIcon,
  DownloadSimpleIcon,
  FilesIcon,
  FileZipIcon,
  FolderIcon,
  FolderSimpleUserIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  SignOutIcon,
  SquaresFourIcon,
  TagIcon,
  TrashIcon,
  TrayArrowUpIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImportedProject, ProjectSummary, PublicUser } from "../shared/api";
import { api, errorText, upload } from "./api";
import { Avatar } from "./avatar";
import { type MessageKey, useI18n } from "./i18n";
import { roleKey } from "./labels";
import { Modal } from "./modal";
import { PublishTemplateDialog } from "./templates";
import { useAction } from "./use-action";

type Filter = "all" | "mine" | "shared" | "archived" | "trashed";
type SortKey = "name" | "owner" | "updated";
type Dialog =
  | { kind: "blank" }
  | { kind: "upload" }
  | { kind: "copy" | "rename" | "delete" | "leave" | "publish"; project: ProjectSummary }
  | { kind: "skipped"; project: ProjectSummary; skipped: string[] }
  | { kind: "tags"; projects: ProjectSummary[] };

const FILTERS: Array<[Filter, MessageKey, typeof FolderIcon]> = [
  ["all", "dash.filter.all", FolderIcon],
  ["mine", "dash.filter.mine", FolderSimpleUserIcon],
  ["shared", "dash.filter.shared", UsersIcon],
  ["archived", "dash.filter.archived", ArchiveIcon],
  ["trashed", "dash.filter.trashed", TrashIcon],
];
/** The server's limit for an uploaded zip. */
const MAX_ZIP = 500_000_000;

export const inFilter = (p: ProjectSummary, filter: Filter) =>
  filter === "trashed"
    ? !!p.trashed
    : filter === "archived"
      ? !!p.archived && !p.trashed
      : !p.archived &&
        !p.trashed &&
        (filter === "all" || (filter === "mine") === (p.role === "owner"));

/** "3 hours ago", in the interface language; full dates after a month. */
export function ago(time: number | undefined, locale: string, justNow: string, now = Date.now()) {
  if (!time) return "—";
  const tag = locale === "zh" ? "zh-CN" : "en";
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return justNow;
  const format = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return format.format(-days, "day");
  return new Date(time).toLocaleDateString(tag);
}

/** A dialog with one name field: new, copy, rename, or the typed confirmation to delete. */
function NameDialog({
  title,
  lead,
  initial,
  submit,
  danger,
  mustEqual,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  lead?: string;
  initial: string;
  submit: string;
  danger?: boolean;
  mustEqual?: string;
  busy: boolean;
  error: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  const ready = mustEqual === undefined ? !!name.trim() : name === mustEqual;
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onSubmit(name);
        }}
      >
        {lead && <p className="muted">{lead}</p>}
        <label>
          {t("dash.dialogName")}
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog exists to type this name.
            autoFocus
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className={danger ? "danger" : "primary"} disabled={busy || !ready} type="submit">
            {busy ? t("common.working") : submit}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function UploadDialog({
  busy,
  error,
  progress,
  onUpload,
  onClose,
}: {
  busy: boolean;
  error: string;
  /** The share of the zip sent so far, while uploading. */
  progress: number | null;
  onUpload: (name: string, zip: File) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null),
    [name, setName] = useState(""),
    [problem, setProblem] = useState(""),
    [over, setOver] = useState(false);
  const choose = (next: File | undefined) => {
    if (!next) return;
    if (!/\.zip$/i.test(next.name)) return setProblem(t("dash.dialogNotZip"));
    if (next.size > MAX_ZIP) return setProblem(t("dash.dialogZipTooLarge"));
    setProblem("");
    setFile(next);
    setName(next.name.replace(/\.zip$/i, ""));
  };
  return (
    <Modal title={t("dash.dialogUploadTitle")} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (file && name.trim()) onUpload(name, file);
        }}
      >
        <p className="muted">{t("dash.dialogUploadLead")}</p>
        <label
          className={`dash-drop ${over ? "over" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            choose(event.dataTransfer.files[0]);
          }}
        >
          <TrayArrowUpIcon aria-hidden="true" />
          <span>{file ? file.name : t("dash.dialogChooseZip")}</span>
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => choose(event.target.files?.[0])}
          />
        </label>
        {file && (
          <label>
            {t("dash.dialogName")}
            <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        {busy && progress !== null && (
          <div className="dash-upload-progress">
            <progress max={1} value={progress} />
            <span className="muted">
              {progress < 1
                ? t("dash.dialogUploading", { percent: Math.floor(progress * 100) })
                : t("dash.dialogUnpacking")}
            </span>
          </div>
        )}
        {(problem || error) && (
          <p className="error" role="alert">
            {problem || error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="primary" type="submit" disabled={busy || !file || !name.trim()}>
            {busy ? t("common.working") : t("dash.dialogUpload")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function Dashboard({
  user,
  onOpen,
  onTemplates,
  initialProjects,
}: {
  user: PublicUser;
  onOpen: (project: ProjectSummary) => void;
  /** The template gallery, optionally showing one template. */
  onTemplates: (template?: string) => void;
  /** For rendering tests; the list is otherwise loaded from the server. */
  initialProjects?: ProjectSummary[];
}) {
  const { t, locale } = useI18n();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(initialProjects ?? null),
    [filter, setFilterState] = useState<Filter>("all"),
    // One of the member's own tags, shown instead of a filter.
    [tag, setTag] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({
      key: "updated",
      ascending: false,
    }),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [menu, setMenu] = useState(false),
    [dialog, setDialog] = useState<Dialog | null>(null);
  const setFilter = (next: Filter) => {
    setFilterState(next);
    setTag(null);
  };
  const { busy, error, setError, run } = useAction();
  const dialogAction = useAction();
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const reload = useCallback(
    () =>
      api<ProjectSummary[]>("/projects")
        .then(setProjects)
        .catch((e) => setError(errorText(e))),
    [setError],
  );
  useEffect(() => {
    if (!initialProjects) void reload();
  }, [reload, initialProjects]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  // Selections belong to one filter.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the filter changes.
  useEffect(() => setSelected(new Set()), [filter, tag]);

  const all = projects ?? [];
  const counts = Object.fromEntries(
    FILTERS.map(([id]) => [id, all.filter((p) => inFilter(p, id)).length]),
  ) as Record<Filter, number>;
  const ownerName = (p: ProjectSummary) => (p.role === "owner" ? t("dash.you") : (p.owner ?? "—"));
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = (projects ?? []).filter(
      (p) =>
        (tag ? !p.trashed && !!p.tags?.includes(tag) : inFilter(p, filter)) &&
        (!needle || `${p.name} ${p.owner ?? ""}`.toLowerCase().includes(needle)),
    );
    const direction = sort.ascending ? 1 : -1;
    return list.sort((a, b) => {
      if (sort.key === "updated")
        return direction * ((a.updated ?? a.created ?? 0) - (b.updated ?? b.created ?? 0));
      const left = sort.key === "name" ? a.name : (a.owner ?? ""),
        right = sort.key === "name" ? b.name : (b.owner ?? "");
      return direction * left.localeCompare(right, locale === "zh" ? "zh-CN" : "en");
    });
  }, [projects, filter, tag, query, sort, locale]);
  // The member's tags, with how many of their (untrashed) projects carry each.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of projects ?? [])
      if (!p.trashed)
        for (const name of p.tags ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b, locale === "zh" ? "zh-CN" : "en"));
  }, [projects, locale]);
  const chosen = visible.filter((p) => selected.has(p.id));

  const close = () => {
    setDialog(null);
    dialogAction.setError("");
  };
  const act = (action: () => Promise<unknown>) =>
    run(async () => {
      await action();
      await reload();
    });
  const each = (list: ProjectSummary[], path: string, body: Record<string, boolean>) =>
    act(async () => {
      for (const p of list) await api(`/projects/${p.id}/${path}`, body);
      setSelected(new Set());
    });
  const download = (list: ProjectSummary[]) => {
    for (const p of list) {
      const link = document.createElement("a");
      link.href = `/api/projects/${encodeURIComponent(p.id)}/export`;
      link.download = `${p.name}.zip`;
      link.click();
    }
  };
  const create = (request: () => Promise<ProjectSummary | ImportedProject>) =>
    dialogAction.run(async () => {
      const made = await request();
      const skipped = "skipped" in made ? made.skipped : [];
      if (skipped.length) {
        setDialog({ kind: "skipped", project: made, skipped });
        void reload();
      } else onOpen(made);
    });
  const sortHeader = (key: SortKey, label: MessageKey) => (
    <th
      scope="col"
      aria-sort={sort.key === key ? (sort.ascending ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        className="dash-sort"
        title={t("dash.sortBy", { column: t(label) })}
        onClick={() =>
          setSort((s) => ({
            key,
            ascending: s.key === key ? !s.ascending : key !== "updated",
          }))
        }
      >
        {t(label)}
        {sort.key === key && (
          <CaretDownIcon className={sort.ascending ? "flip" : ""} aria-hidden="true" />
        )}
      </button>
    </th>
  );
  const iconButton = (
    label: MessageKey,
    Icon: typeof FolderIcon,
    onClick: () => void,
    danger = false,
    /** Left out on phones, where the row has room for few buttons. */
    wideOnly = false,
  ) => (
    <button
      type="button"
      className={`icon ${danger ? "danger-text" : ""} ${wideOnly ? "dash-wide-only" : ""}`}
      title={t(label)}
      aria-label={t(label)}
      disabled={busy}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
    </button>
  );
  const rowActions = (p: ProjectSummary) =>
    p.trashed ? (
      <>
        {iconButton("dash.restore", ArrowCounterClockwiseIcon, () =>
          each([p], "trash", { trashed: false }),
        )}
        {p.role === "owner"
          ? iconButton(
              "dash.deleteForever",
              TrashIcon,
              () => setDialog({ kind: "delete", project: p }),
              true,
            )
          : iconButton(
              "dash.leave",
              SignOutIcon,
              () => setDialog({ kind: "leave", project: p }),
              true,
            )}
      </>
    ) : (
      <>
        {p.role === "owner" &&
          iconButton("dash.rename", PencilSimpleIcon, () =>
            setDialog({ kind: "rename", project: p }),
          )}
        {iconButton(
          "dash.copy",
          CopyIcon,
          () => setDialog({ kind: "copy", project: p }),
          false,
          true,
        )}
        {(p.role === "owner" || p.role === "editor") &&
          iconButton(
            "tpl.publish",
            BookBookmarkIcon,
            () => setDialog({ kind: "publish", project: p }),
            false,
            true,
          )}
        {iconButton(
          "dash.tags",
          TagIcon,
          () => setDialog({ kind: "tags", projects: [p] }),
          false,
          true,
        )}
        {iconButton("dash.download", DownloadSimpleIcon, () => download([p]), false, true)}
        {p.archived
          ? iconButton("dash.unarchive", ArchiveIcon, () =>
              each([p], "archive", { archived: false }),
            )
          : iconButton("dash.archive", ArchiveIcon, () => each([p], "archive", { archived: true }))}
        {iconButton("dash.trash", TrashIcon, () => each([p], "trash", { trashed: true }))}
      </>
    );
  const empty =
    filter === "archived"
      ? t("dash.emptyArchived")
      : filter === "trashed"
        ? t("dash.emptyTrashed")
        : filter === "shared"
          ? t("dash.emptyShared")
          : t("dash.noMatch");

  return (
    <div className="dash">
      <div className="dash-body">
        <aside className="dash-side">
          <div className="dash-new" ref={menuRef}>
            <button
              type="button"
              className="primary"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
            >
              <PlusIcon aria-hidden="true" />
              {t("dash.newProject")}
              <CaretDownIcon aria-hidden="true" />
            </button>
            {menu && (
              <div className="dash-menu" role="menu">
                {(
                  [
                    ["blank", "dash.blankProject", FilesIcon],
                    ["templates", "dash.fromTemplate", SquaresFourIcon],
                    ["upload", "dash.uploadProject", FileZipIcon],
                  ] as const
                ).map(([kind, label, Icon]) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      if (kind === "templates") onTemplates();
                      else setDialog({ kind });
                    }}
                  >
                    <Icon aria-hidden="true" />
                    {t(label)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <nav aria-label={t("dash.filters")}>
            {FILTERS.map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                aria-current={!tag && filter === id ? "page" : undefined}
                className={!tag && filter === id ? "selected" : ""}
                onClick={() => setFilter(id)}
              >
                <Icon aria-hidden="true" />
                <span>{t(label)}</span>
                <span className="dash-count">{counts[id]}</span>
              </button>
            ))}
          </nav>
          {!!tagCounts.length && (
            <nav aria-label={t("dash.tagsHeading")} className="dash-tags">
              <h2>{t("dash.tagsHeading")}</h2>
              {tagCounts.map(([name, count]) => (
                <div key={name} className="dash-tag-row">
                  <button
                    type="button"
                    aria-current={tag === name ? "page" : undefined}
                    className={tag === name ? "selected" : ""}
                    onClick={() => setTag(name)}
                  >
                    <TagIcon aria-hidden="true" />
                    <span>{name}</span>
                    <span className="dash-count">{count}</span>
                  </button>
                  <button
                    type="button"
                    className="icon"
                    title={t("dash.renameTag")}
                    aria-label={t("dash.renameTag")}
                    onClick={() => {
                      const to = prompt(t("dash.renameTagPrompt"), name)?.trim();
                      if (to && to !== name)
                        act(async () => {
                          await api("/tags/rename", { from: name, to });
                          if (tag === name) setTag(to);
                        });
                    }}
                  >
                    <PencilSimpleIcon aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon"
                    title={t("dash.deleteTag")}
                    aria-label={t("dash.deleteTag")}
                    onClick={() => {
                      if (confirm(t("dash.deleteTagConfirm", { name })))
                        act(async () => {
                          await api("/tags/delete", { tag: name });
                          if (tag === name) setTag(null);
                        });
                    }}
                  >
                    <TrashIcon aria-hidden="true" />
                  </button>
                </div>
              ))}
            </nav>
          )}
          <button type="button" className="dash-templates-link" onClick={() => onTemplates()}>
            <SquaresFourIcon aria-hidden="true" />
            <span>{t("tpl.open")}</span>
          </button>
        </aside>
        <main className="dash-main">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {projects && !all.length ? (
            <section className="dash-welcome">
              <h1>{t("dash.welcomeTitle")}</h1>
              <p>{t("dash.welcomeLead")}</p>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  onClick={() => setDialog({ kind: "blank" })}
                >
                  <FilesIcon aria-hidden="true" />
                  {t("dash.blankProject")}
                </button>
                <button type="button" onClick={() => onTemplates()}>
                  <SquaresFourIcon aria-hidden="true" />
                  {t("dash.fromTemplate")}
                </button>
                <button type="button" onClick={() => setDialog({ kind: "upload" })}>
                  <FileZipIcon aria-hidden="true" />
                  {t("dash.uploadProject")}
                </button>
              </div>
            </section>
          ) : (
            <>
              <div className="dash-toolbar">
                {chosen.length ? (
                  <div
                    className="dash-bulk"
                    role="toolbar"
                    aria-label={t("dash.selected", { count: chosen.length })}
                  >
                    <strong>{t("dash.selected", { count: chosen.length })}</strong>
                    {filter === "trashed" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => each(chosen, "trash", { trashed: false })}
                      >
                        <ArrowCounterClockwiseIcon aria-hidden="true" />
                        {t("dash.restore")}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setDialog({ kind: "tags", projects: chosen })}
                        >
                          <TagIcon aria-hidden="true" />
                          {t("dash.tags")}
                        </button>
                        <button type="button" disabled={busy} onClick={() => download(chosen)}>
                          <DownloadSimpleIcon aria-hidden="true" />
                          {t("dash.download")}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            each(chosen, "archive", { archived: filter !== "archived" })
                          }
                        >
                          <ArchiveIcon aria-hidden="true" />
                          {filter === "archived" ? t("dash.unarchive") : t("dash.archive")}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => each(chosen, "trash", { trashed: true })}
                        >
                          <TrashIcon aria-hidden="true" />
                          {t("dash.trash")}
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => setSelected(new Set())}>
                      {t("dash.clearSelection")}
                    </button>
                  </div>
                ) : (
                  <h1>{t(FILTERS.find(([id]) => id === filter)?.[1] ?? "dash.projects")}</h1>
                )}
                <label className="dash-search">
                  <MagnifyingGlassIcon aria-hidden="true" />
                  <input
                    type="search"
                    aria-label={t("dash.search")}
                    placeholder={t("dash.search")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
              </div>
              {!projects ? (
                <p className="muted">{t("common.loading")}</p>
              ) : !visible.length ? (
                <p className="dash-empty">{empty}</p>
              ) : (
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th scope="col" className="dash-check">
                        <input
                          type="checkbox"
                          aria-label={t("dash.selectAll")}
                          checked={chosen.length === visible.length}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked ? new Set(visible.map((p) => p.id)) : new Set(),
                            )
                          }
                        />
                      </th>
                      {sortHeader("name", "dash.column.name")}
                      {sortHeader("owner", "dash.column.owner")}
                      {sortHeader("updated", "dash.column.updated")}
                      <th scope="col" className="dash-actions-head">
                        {t("dash.column.actions")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((p) => (
                      <tr key={p.id} className={selected.has(p.id) ? "selected" : ""}>
                        <td className="dash-check">
                          <input
                            type="checkbox"
                            aria-label={t("dash.selectProject", { name: p.name })}
                            checked={selected.has(p.id)}
                            onChange={(event) =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(p.id);
                                else next.delete(p.id);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="dash-name">
                          <a
                            href={`/?project=${encodeURIComponent(p.id)}`}
                            onClick={(event) => {
                              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                              event.preventDefault();
                              onOpen(p);
                            }}
                          >
                            {p.name}
                          </a>
                          <span className="dash-meta">
                            {t(roleKey[p.role])} · {ownerName(p)} ·{" "}
                            {ago(p.updated ?? p.created, locale, t("dash.justNow"))}
                          </span>
                        </td>
                        <td className="dash-owner">
                          <span className="dash-person">
                            {p.ownerId && (
                              <Avatar
                                person={{
                                  id: p.ownerId,
                                  name: p.role === "owner" ? user.name : (p.owner ?? ""),
                                  avatar: p.role === "owner" ? user.avatar : p.ownerAvatar,
                                }}
                                size={24}
                              />
                            )}
                            {ownerName(p)}
                          </span>
                        </td>
                        <td
                          className="dash-updated"
                          title={p.updated ? new Date(p.updated).toLocaleString() : undefined}
                        >
                          {ago(p.updated ?? p.created, locale, t("dash.justNow"))}
                        </td>
                        <td className="dash-actions">{rowActions(p)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </main>
      </div>
      {dialog?.kind === "blank" && (
        <NameDialog
          title={t("dash.dialogNewTitle")}
          initial=""
          submit={t("dash.dialogCreate")}
          busy={dialogAction.busy}
          error={dialogAction.error}
          onClose={close}
          onSubmit={(name) =>
            create(() => api<ProjectSummary>("/projects", { name, template: "blank" }))
          }
        />
      )}
      {dialog?.kind === "publish" && (
        <PublishTemplateDialog
          project={dialog.project}
          onClose={close}
          onDone={(template) => {
            close();
            onTemplates(template.id);
          }}
        />
      )}
      {dialog?.kind === "upload" && (
        <UploadDialog
          busy={dialogAction.busy}
          error={dialogAction.error}
          onClose={close}
          progress={uploadProgress}
          onUpload={(name, zip) => {
            setUploadProgress(0);
            create(() =>
              upload<ImportedProject>(
                `/projects/import?name=${encodeURIComponent(name.trim())}`,
                zip,
                setUploadProgress,
              ),
            );
          }}
        />
      )}
      {dialog?.kind === "copy" && (
        <NameDialog
          title={t("dash.dialogCopyTitle")}
          lead={t("dash.dialogCopyLead")}
          initial={t("dash.dialogCopyName", { name: dialog.project.name })}
          submit={t("dash.copy")}
          busy={dialogAction.busy}
          error={dialogAction.error}
          onClose={close}
          onSubmit={(name) =>
            create(() => api<ProjectSummary>(`/projects/${dialog.project.id}/copy`, { name }))
          }
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={t("dash.dialogRenameTitle")}
          initial={dialog.project.name}
          submit={t("common.save")}
          busy={dialogAction.busy}
          error={dialogAction.error}
          onClose={close}
          onSubmit={(name) =>
            dialogAction.run(async () => {
              await api(`/projects/${dialog.project.id}`, { name }, "PATCH");
              close();
              await reload();
            })
          }
        />
      )}
      {dialog?.kind === "delete" && (
        <NameDialog
          title={t("dash.dialogDeleteTitle")}
          lead={t("dash.dialogDeleteLead", { name: dialog.project.name })}
          initial=""
          mustEqual={dialog.project.name}
          danger
          submit={t("dash.deleteForever")}
          busy={dialogAction.busy}
          error={dialogAction.error}
          onClose={close}
          onSubmit={(confirm) =>
            dialogAction.run(async () => {
              await api(`/projects/${dialog.project.id}`, { confirm }, "DELETE");
              close();
              await reload();
            })
          }
        />
      )}
      {dialog?.kind === "tags" && (
        <TagsDialog
          projects={dialog.projects}
          known={tagCounts.map(([name]) => name)}
          busy={dialogAction.busy}
          error={dialogAction.error}
          onClose={close}
          onSave={(changes) =>
            dialogAction.run(async () => {
              for (const [id, tags] of changes) await api(`/projects/${id}/tags`, { tags }, "PUT");
              close();
              await reload();
            })
          }
        />
      )}
      {dialog?.kind === "leave" && (
        <Modal title={t("dash.dialogLeaveTitle")} onClose={close}>
          <p>{t("dash.dialogLeaveLead", { name: dialog.project.name })}</p>
          {dialogAction.error && (
            <p className="error" role="alert">
              {dialogAction.error}
            </p>
          )}
          <footer>
            <button type="button" onClick={close}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="danger"
              disabled={dialogAction.busy}
              onClick={() =>
                dialogAction.run(async () => {
                  await api(`/projects/${dialog.project.id}/leave`, {});
                  close();
                  await reload();
                })
              }
            >
              {t("dash.leave")}
            </button>
          </footer>
        </Modal>
      )}
      {dialog?.kind === "skipped" && (
        <Modal title={dialog.project.name} onClose={close}>
          <p>{t("dash.dialogSkipped")}</p>
          <ul className="dash-skipped">
            {dialog.skipped.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
          <footer>
            <button type="button" onClick={close}>
              {t("common.close")}
            </button>
            <button type="button" className="primary" onClick={() => onOpen(dialog.project)}>
              {t("dash.dialogOpenProject")}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}

/**
 * The member's tags for one or more projects: a tag ticked is on all of them, cleared on none,
 * and a half-ticked one (on some) stays as it is unless clicked.
 */
function TagsDialog({
  projects,
  known,
  busy,
  error,
  onClose,
  onSave,
}: {
  projects: ProjectSummary[];
  known: string[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (changes: [string, string[]][]) => void;
}) {
  const { t } = useI18n();
  const initial = (name: string) => {
    const having = projects.filter((p) => p.tags?.includes(name)).length;
    return having === projects.length ? true : having ? null : false;
  };
  const [names, setNames] = useState(known);
  const [state, setState] = useState<Record<string, boolean | null>>(() =>
    Object.fromEntries(known.map((name) => [name, initial(name)])),
  );
  const [adding, setAdding] = useState("");
  const add = () => {
    const name = adding.trim().replace(/\s+/g, " ");
    if (!name || name.length > 40) return;
    if (!names.includes(name)) setNames((old) => [...old, name]);
    setState((old) => ({ ...old, [name]: true }));
    setAdding("");
  };
  return (
    <Modal title={t("dash.tagsTitle", { count: projects.length })} onClose={onClose}>
      <div className="dash-tag-choices">
        {names.map((name) => (
          <label key={name} className="dash-tag-choice">
            <input
              type="checkbox"
              checked={state[name] === true}
              ref={(input) => {
                if (input) input.indeterminate = state[name] === null;
              }}
              onChange={(e) => setState((old) => ({ ...old, [name]: e.target.checked }))}
            />
            {name}
          </label>
        ))}
        {!names.length && <p className="muted">{t("dash.noTags")}</p>}
      </div>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder={t("dash.newTag")}
          aria-label={t("dash.newTag")}
          maxLength={40}
        />
        <button type="submit" disabled={!adding.trim()}>
          {t("dash.addTag")}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() =>
            onSave(
              projects.map((p) => {
                const tags = new Set(p.tags ?? []);
                for (const name of names) {
                  if (state[name] === true) tags.add(name);
                  else if (state[name] === false) tags.delete(name);
                }
                return [p.id, [...tags]];
              }),
            )
          }
        >
          {t("common.save")}
        </button>
      </footer>
    </Modal>
  );
}
