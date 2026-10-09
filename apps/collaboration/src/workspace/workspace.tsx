/**
 * The project workbench in the browser, laid out like the desktop app: a header with panel
 * toggles and compiling, a status bar, Files and History in the left sidebar, open-file tabs
 * with the editor and the PDF beside it, the build log below (the desktop's terminal) and AI
 * tasks on the right (the desktop's assistant). Phones get the side panels as overlays.
 */
import { pathSync, TabBar, type TabItem } from "@lmms-lab/workbench";
import { parseBib } from "@lmms-lab/writing";
import {
  ChatCircleTextIcon,
  CrosshairIcon,
  DownloadSimpleIcon,
  FilePdfIcon,
  PlayCircleIcon,
  RobotIcon,
  SidebarSimpleIcon,
  SquaresFourIcon,
  TerminalIcon,
  UsersIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Engine, FileInfo, ProjectSummary, PublicUser, Role } from "../../shared/api";
import { download } from "../api";
import { Editor, type EditorHandle, type Peer, type Selection } from "../editor";
import { useI18n } from "../i18n";
import { roleKey, statusKey } from "../labels";
import { projectHints } from "../latex-completion";
import type { SyncStatus } from "../provider";
import { useAction } from "../use-action";
import { BinaryPreview } from "./binary-preview";
import { useBuild } from "./build";
import { CommentsPanel } from "./comments-panel";
import type { WorkspaceContext } from "./context";
import { FilePanel } from "./file-panel";
import { HistoryPanel } from "./history-panel";
import { LogPanel } from "./log-panel";
import { PdfPane } from "./pdf-pane";
import { ReferencesDialog } from "./references-dialog";
import { ReviewDialog } from "./review-dialog";
import { ShareDialog } from "./share-dialog";
import { TasksPanel } from "./tasks-panel";
import { Btn, ResizeHandle, Select, ToggleButton, useStoredSize } from "./ui";
import { useProject } from "./use-project";

/** The comment being written survives reloads (stored per user and project). */
function useCommentDraft(key: string, report: (message: string) => void) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(""),
    [selection, setSelection] = useState<Selection | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved) {
        setDraft(saved.body || "");
        setSelection(saved.selection || null);
      }
    } catch {}
  }, [key]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ body: draft, selection }));
    } catch {
      report(t("workspace.draftNotSaved"));
    }
  }, [draft, selection, key, report, t]);
  return { draft, setDraft, selection, setSelection };
}

/** Narrow windows show the side panels over the editor instead of beside it. */
function useNarrow() {
  const query = "(max-width: 900px)";
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const changed = () => setNarrow(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  return narrow;
}

const SYNC_TONE: Record<SyncStatus, string> = {
  connecting: "text-muted animate-pulse",
  saved: "text-emerald-700",
  saving: "text-amber-700 animate-pulse",
  offline: "text-red-600",
  denied: "text-red-600",
};

export function Workspace({
  project,
  user,
  onBack,
}: {
  project: ProjectSummary;
  user: PublicUser;
  onBack: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const prefix = `/projects/${project.id}`;
  const [role, setRole] = useState<Role>(project.role),
    [status, setStatus] = useState<SyncStatus>("connecting"),
    [notice, setNotice] = useState(""),
    [openIds, setOpenIds] = useState<string[]>([]),
    [activeId, setActiveId] = useState<string | null>(null),
    [peers, setPeers] = useState<Peer[]>([]),
    [text, setText] = useState<{ file: string; value: string } | null>(null);
  const narrow = useNarrow();
  const [sidebar, setSidebar] = useState(!narrow),
    [sidebarTab, setSidebarTab] = useState<"files" | "history">("files"),
    [rightOpen, setRightOpen] = useState(false),
    [logOpen, setLogOpen] = useState(false),
    [commentsOpen, setCommentsOpen] = useState(false),
    [dialog, setDialog] = useState<"share" | "references" | "review" | null>(null);
  const sidebarSize = useStoredSize("writer-web-sidebar", 260, 180, 520),
    rightSize = useStoredSize("writer-web-right", 380, 280, 720),
    pdfSize = useStoredSize("writer-web-pdf", 560, 260, 1600),
    logSize = useStoredSize("writer-web-log", 220, 120, 640);
  const { busy, error, setError, run } = useAction();
  const data = useProject(prefix, { onRole: setRole, onError: setError });
  const editor = useRef<EditorHandle | null>(null);
  const comment = useCommentDraft(`writer-note-draft:${user.id}:${project.id}`, setError);
  // The whole page is the workbench while a project is open, so menus and dialogs that the
  // shared components portal to <body> get its styles too.
  useEffect(() => {
    document.body.classList.add("wb");
    return () => document.body.classList.remove("wb");
  }, []);
  useEffect(() => {
    if (narrow) {
      setSidebar(false);
      setRightOpen(false);
    }
  }, [narrow]);
  // Tabs follow the file list (renames, deletions); the first visit opens the main file.
  useEffect(() => {
    const ids = new Set(data.files.map((f) => f.id));
    setOpenIds((list) => list.filter((id) => ids.has(id)));
    setActiveId((old) => {
      if (old && ids.has(old)) return old;
      const first =
        data.files.find((f) => f.path === "main.tex") ??
        data.files.find((f) => f.path.endsWith(".tex")) ??
        data.files[0];
      return first?.id ?? null;
    });
  }, [data.files]);
  useEffect(() => {
    if (activeId) setOpenIds((list) => (list.includes(activeId) ? list : [...list, activeId]));
  }, [activeId]);
  const file = data.files.find((f) => f.id === activeId) ?? null;
  const hints = useMemo(() => projectHints(data.sources, parseBib), [data.sources]);
  const hintsRef = useRef(hints);
  hintsRef.current = hints;
  const ws: WorkspaceContext = {
    prefix,
    project,
    user,
    role,
    canEdit: role === "owner" || role === "editor",
    canComment: role !== "viewer",
    busy,
    run,
    reload: data.reload,
    notify: setNotice,
    report: setError,
    editor,
    file,
    files: data.files,
    openFile: (next: FileInfo) => {
      setActiveId(next.id);
      comment.setSelection(null);
      if (narrow) setSidebar(false);
    },
    status,
  };
  const b = useBuild(ws, data.latestBuild, data.sources);
  const compileRef = useRef(b.compile);
  compileRef.current = b.compile;
  // Overleaf's and the desktop's shortcuts both compile.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && (key === "s" || key === "enter" || (event.shiftKey && key === "b"))) {
        event.preventDefault();
        compileRef.current();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  const tabs = openIds
    .map((id) => data.files.find((f) => f.id === id))
    .filter((f): f is FileInfo => !!f)
    .map((f): TabItem => ({ id: f.id, label: pathSync.basename(f.path), title: f.path }));
  const closeTabs = useCallback(
    (keep: (id: string, index: number, list: string[]) => boolean) =>
      setOpenIds((list) => {
        const next = list.filter((id, i) => keep(id, i, list));
        setActiveId((current) =>
          current && next.includes(current) ? current : (next.at(-1) ?? null),
        );
        return next;
      }),
    [],
  );
  const pendingReview = data.proposals.reduce(
    (n, p) => n + p.hunks.filter((h) => h.status === "pending").length,
    0,
  );
  const outlinePath = file?.path.endsWith(".tex") ? file.path : b.chosenMain || undefined;
  const pdfShown = b.open && !narrow;
  const editorActions = file && !file.binary && (
    <>
      <button
        type="button"
        disabled={!ws.canComment}
        className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40"
        title={t("workspace.commentSelection")}
        onClick={() => {
          const s = editor.current?.selection();
          if (!s) {
            setError(t("workspace.selectFirst"));
            return;
          }
          comment.setSelection(s);
          setCommentsOpen(true);
        }}
      >
        <ChatCircleTextIcon className="size-3.5" />
        <span className="hidden sm:inline">{t("workspace.commentSelection")}</span>
      </button>
      {b.build?.pdf && (
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground"
          title={t("build.forwardTitle")}
          onClick={b.showCursorInPdf}
        >
          <CrosshairIcon className="size-3.5" />
          <span className="hidden sm:inline">{t("build.forward")}</span>
        </button>
      )}
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        title={t("workspace.exportText")}
        onClick={() =>
          download(
            file.path.split("/").pop() || "recovery.tex",
            new Blob([editor.current?.text() || ""], { type: "text/plain;charset=utf-8" }),
          )
        }
      >
        <DownloadSimpleIcon className="size-3.5" />
      </button>
    </>
  );
  const overlay = (side: "left" | "right", content: ReactNode, close: () => void) => (
    <div className="absolute inset-0 z-30 flex">
      {side === "right" && (
        <button
          type="button"
          aria-label={t("shell.closePanel")}
          className="flex-1 bg-black/20"
          onClick={close}
        />
      )}
      <aside className="flex w-[86vw] max-w-sm flex-col border-border bg-background shadow-xl">
        {content}
      </aside>
      {side === "left" && (
        <button
          type="button"
          aria-label={t("shell.closePanel")}
          className="flex-1 bg-black/20"
          onClick={close}
        />
      )}
    </div>
  );
  const sidebarContent = (
    <>
      <TabBar
        tabs={[
          { id: "files", label: t("shell.files") },
          { id: "history", label: t("shell.history"), badge: data.snapshots.length || undefined },
        ]}
        activeTab={sidebarTab}
        onTabSelect={(id) => setSidebarTab(id as "files" | "history")}
        variant="sidebar"
      />
      {sidebarTab === "files" ? (
        <FilePanel
          ws={ws}
          outlinePath={outlinePath}
          outlineSource={text && text.file === outlinePath ? text.value : undefined}
          onOutline={(path, line) => b.openLocation(path, line)}
        />
      ) : (
        <HistoryPanel ws={ws} snapshots={data.snapshots} />
      )}
    </>
  );
  const tasks = (
    <TasksPanel
      project={project.id}
      memberRole={role}
      jobs={data.jobs}
      currentFile={file?.path}
      reload={data.reload}
      onError={setError}
    />
  );
  const center = file ? (
    file.binary ? (
      <BinaryPreview key={file.id} prefix={prefix} file={file} />
    ) : (
      <Editor
        key={file.id}
        project={project.id}
        file={file.id}
        user={user}
        role={role}
        comments={data.comments}
        onRole={setRole}
        onStatus={setStatus}
        onError={setError}
        onReady={(handle) => {
          editor.current = handle;
        }}
        hints={() => hintsRef.current}
        onText={(value) => setText({ file: file.path, value })}
        onPeers={setPeers}
        actions={editorActions}
      />
    )
  ) : (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-accent-hover p-6 text-center">
      <h2 className="text-sm font-medium">{t("workspace.emptyTitle")}</h2>
      <p className="text-xs text-muted">{t("workspace.emptyLead")}</p>
    </div>
  );
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-border">
        <div className="flex w-full items-center justify-between gap-3 px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              title={t("shell.backToProjects")}
              className="shrink-0"
            >
              <img src="/logo-small-light.svg" alt="Y-Writer" className="h-7 w-auto" />
            </button>
            <span className="hidden text-border sm:inline">/</span>
            <div className="truncate text-sm font-medium" title={project.name}>
              {project.name}
            </div>
            <span className="hidden shrink-0 border border-border px-1.5 py-0.5 text-[10px] tracking-wider text-muted sm:inline">
              {t(roleKey[role])}
            </span>
            <button
              type="button"
              onClick={onBack}
              className="hidden h-8 shrink-0 items-center gap-1.5 border border-border px-2 text-xs hover:bg-accent-hover md:flex"
            >
              <SquaresFourIcon className="size-4" aria-hidden="true" />
              {t("shell.projects")}
            </button>
          </div>
          <div className="flex h-8 items-center gap-2 sm:gap-3">
            <ToggleButton
              pressed={sidebar}
              label={t("shell.toggleSidebar")}
              onClick={() => setSidebar((v) => !v)}
            >
              <SidebarSimpleIcon className="size-4" weight="bold" />
            </ToggleButton>
            <ToggleButton
              pressed={logOpen}
              label={t("shell.toggleLog")}
              onClick={() => setLogOpen((v) => !v)}
            >
              <TerminalIcon className="size-4" weight="bold" />
            </ToggleButton>
            <ToggleButton
              pressed={b.open}
              label={t("shell.togglePdf")}
              onClick={() => b.setOpen(!b.open)}
            >
              <FilePdfIcon className="size-4" weight="bold" />
            </ToggleButton>
            <ToggleButton
              pressed={rightOpen}
              label={t("shell.toggleAi")}
              onClick={() => setRightOpen((v) => !v)}
            >
              <RobotIcon className="size-4" weight="bold" />
            </ToggleButton>
            <span className="hidden select-none text-lg text-border sm:inline">/</span>
            <Select
              aria-label={t("build.main")}
              value={b.chosenMain}
              onChange={(e) => b.setMain(e.target.value)}
              className="hidden max-w-40 truncate lg:block"
            >
              {b.texFiles.map((f) => (
                <option key={f.id} value={f.path}>
                  {f.path}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t("build.engine")}
              value={b.chosenEngine}
              onChange={(e) => b.setEngine(e.target.value as Engine)}
              className="hidden lg:block"
            >
              <option value="pdflatex">pdfLaTeX</option>
              <option value="xelatex">XeLaTeX</option>
              <option value="lualatex">LuaLaTeX</option>
            </Select>
            <ToggleButton
              label={b.compiling ? t("build.compiling") : t("shell.compileShortcut")}
              disabled={!ws.canComment || b.compiling || !b.texFiles.length || status === "saving"}
              onClick={b.compile}
              className={b.compiling ? "animate-pulse" : ""}
            >
              <PlayCircleIcon className="size-4" />
            </ToggleButton>
            <button
              type="button"
              onClick={() => setDialog("share")}
              className="flex h-8 shrink-0 items-center gap-1.5 border border-foreground bg-foreground px-2 text-xs text-background hover:opacity-90"
            >
              <UsersIcon className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("shell.share")}</span>
            </button>
          </div>
        </div>
      </header>
      <div className="shrink-0 border-b border-border bg-background text-xs" aria-live="polite">
        <div className="flex flex-wrap items-center gap-3 px-3 py-1.5">
          <span role="status" className={file && !file.binary ? SYNC_TONE[status] : "text-muted"}>
            {file && !file.binary ? t(statusKey[status]) : t("workspace.filePreview")}
          </span>
          {peers.length > 0 && (
            <span className="flex items-center gap-1" title={peers.map((p) => p.name).join(", ")}>
              {peers.slice(0, 5).map((p) => (
                <span
                  key={p.name}
                  className="flex h-5 w-5 items-center justify-center text-[10px] font-medium text-white"
                  style={{ background: p.color }}
                >
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
              ))}
              <span className="text-muted">{t("shell.online", { count: peers.length })}</span>
            </span>
          )}
          <CommentsPanel
            ws={ws}
            comments={data.comments}
            open={commentsOpen}
            setOpen={setCommentsOpen}
            {...comment}
          />
          <Btn onClick={() => setDialog("references")}>{t("tab.bibliography")}</Btn>
          <Btn onClick={() => setDialog("review")}>
            {pendingReview ? t("shell.reviewCount", { count: pendingReview }) : t("tab.review")}
          </Btn>
          <a
            href={`/api${prefix}/export`}
            className="border border-border px-2 py-1 hover:border-foreground"
          >
            {t("workspace.export")}
          </a>
          <a
            href={`lmms-writer://open?server=${encodeURIComponent(location.origin)}&project=${encodeURIComponent(project.id)}`}
            title={t("workspace.openDesktopTitle")}
            className="hidden border border-border px-2 py-1 hover:border-foreground sm:inline"
          >
            {t("workspace.openDesktop")}
          </a>
          <div className="ml-auto flex items-center gap-3">
            <Select
              aria-label={t("language.label")}
              value={locale}
              onChange={(e) => setLocale(e.target.value === "en" ? "en" : "zh")}
              className="h-7"
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </Select>
            <span className="hidden text-muted sm:inline">{user.name}</span>
          </div>
        </div>
        {(error || notice) && (
          <div
            role={error ? "alert" : "status"}
            className={`flex items-start gap-2 border-t border-border px-3 py-1.5 ${error ? "text-red-600" : ""}`}
          >
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{error || notice}</span>
            <button
              type="button"
              aria-label={t("shell.dismiss")}
              onClick={() => {
                setError("");
                setNotice("");
              }}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      <main className="relative flex min-h-0 flex-1 overflow-hidden">
        {sidebar &&
          (narrow ? (
            overlay("left", sidebarContent, () => setSidebar(false))
          ) : (
            <>
              <aside
                style={{ width: sidebarSize.size }}
                className="flex shrink-0 flex-col overflow-hidden border-r border-border"
              >
                {sidebarContent}
              </aside>
              <ResizeHandle
                label={t("shell.resizeSidebar")}
                onResize={sidebarSize.resize}
                onDone={sidebarSize.save}
              />
            </>
          ))}
        <div className="flex w-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1">
            {narrow && b.open ? (
              <PdfPane ws={ws} b={b} onClose={() => b.setOpen(false)} />
            ) : (
              <div className="flex min-w-0 flex-1 flex-col">
                {tabs.length > 0 && (
                  <TabBar
                    tabs={tabs}
                    activeTab={activeId ?? ""}
                    onTabSelect={setActiveId}
                    onTabClose={(id) => closeTabs((other) => other !== id)}
                    onTabReorder={(dragged, target, position) =>
                      setOpenIds((list) => {
                        const rest = list.filter((id) => id !== dragged);
                        const at = rest.indexOf(target) + (position === "after" ? 1 : 0);
                        return [...rest.slice(0, at), dragged, ...rest.slice(at)];
                      })
                    }
                    onCloseOthers={(id) => closeTabs((other) => other === id)}
                    onCloseToLeft={(id) => closeTabs((_, i, list) => i >= list.indexOf(id))}
                    onCloseToRight={(id) => closeTabs((_, i, list) => i <= list.indexOf(id))}
                    onCloseAll={() => closeTabs(() => false)}
                    variant="editor"
                  />
                )}
                {center}
              </div>
            )}
            {pdfShown && (
              <>
                <ResizeHandle
                  label={t("shell.resizePdf")}
                  onResize={(delta) => pdfSize.resize(-delta)}
                  onDone={pdfSize.save}
                />
                <div
                  style={{ width: pdfSize.size }}
                  className="flex min-w-0 shrink-0 flex-col border-l border-border"
                >
                  <PdfPane ws={ws} b={b} onClose={() => b.setOpen(false)} />
                </div>
              </>
            )}
          </div>
          {logOpen && (
            <>
              <ResizeHandle
                vertical
                label={t("shell.resizeLog")}
                onResize={(delta) => logSize.resize(-delta)}
                onDone={logSize.save}
              />
              <div style={{ height: logSize.size }} className="shrink-0 border-t border-border">
                <LogPanel b={b} onClose={() => setLogOpen(false)} />
              </div>
            </>
          )}
        </div>
        {rightOpen &&
          (narrow ? (
            overlay("right", tasks, () => setRightOpen(false))
          ) : (
            <>
              <ResizeHandle
                label={t("shell.resizeRight")}
                onResize={(delta) => rightSize.resize(-delta)}
                onDone={rightSize.save}
              />
              <aside
                style={{ width: rightSize.size }}
                className="flex shrink-0 flex-col overflow-hidden border-l border-border"
              >
                {tasks}
              </aside>
            </>
          ))}
      </main>
      {dialog === "share" && (
        <ShareDialog
          ws={ws}
          members={data.members}
          onClose={() => setDialog(null)}
          onDeleted={onBack}
        />
      )}
      {dialog === "references" && (
        <ReferencesDialog
          ws={ws}
          sources={data.sources}
          refreshSources={data.refreshSources}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "review" && (
        <ReviewDialog ws={ws} proposals={data.proposals} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
