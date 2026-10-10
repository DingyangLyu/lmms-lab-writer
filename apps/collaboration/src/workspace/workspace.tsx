/**
 * The project workbench in the browser, laid out like the desktop app: one header row with the
 * project, its save state, panel toggles, compiling and a menu, Files and History in the left sidebar, open-file tabs
 * with the editor and the PDF beside it, the build log below (the desktop's terminal) and AI
 * conversations on the right (the desktop's assistant). Phones get the side panels as overlays.
 */
import {
  type PdfAnnotation,
  type PdfAnnotationHost,
  pathSync,
  TabBar,
  type TabItem,
  WorkbenchLocale,
} from "@lmms-lab/workbench";
import type { EditorSelectionContext } from "@lmms-lab/workbench/agents";
import { parseBib } from "@lmms-lab/writing";
import {
  ChatCircleTextIcon,
  ChatsCircleIcon,
  CrosshairIcon,
  DownloadSimpleIcon,
  FilePdfIcon,
  PencilSimpleIcon,
  RobotIcon,
  SidebarSimpleIcon,
  TerminalIcon,
  UsersIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileInfo, ProjectSummary, PublicUser, Role } from "../../shared/api";
import { api, download } from "../api";
import { Editor, type EditorHandle, type Peer } from "../editor";
import { useEditorSettings } from "../editor-settings";
import { useI18n } from "../i18n";
import { roleKey, statusKey } from "../labels";
import { projectHints } from "../latex-completion";
import type { SyncStatus } from "../provider";
import { useAction } from "../use-action";
import type { AiTask } from "./agents-panel";
import { BinaryPreview } from "./binary-preview";
import { useBuild } from "./build";
import { CommentsPanel } from "./comments-panel";
import type { WorkspaceContext } from "./context";
import { FilePanel } from "./file-panel";
import { CompileButton, VersionStatus, WorkspaceMenu } from "./header";
import { HistoryPanel } from "./history-panel";
import { LogPanel } from "./log-panel";
import { draftFromPdf, postDraft, useDraft } from "./notes";
import { OUTPUT_PDF, PdfPane } from "./pdf-pane";
import { ReferencesDialog } from "./references-dialog";
import { ReviewDialog } from "./review-dialog";
import { type MarginLayout, ReviewMargin } from "./review-margin";
import { ShareDialog } from "./share-dialog";
import { Btn, ResizeHandle, ToggleButton, useStoredSize } from "./ui";
import { useProject } from "./use-project";

/** The chat panel (with its Markdown renderer) loads when the right column first opens. */
const AgentsPanel = lazy(() => import("./agents-panel").then((m) => ({ default: m.AgentsPanel })));
/** Whether two quoted selections are the same (the panel's own test, without loading it). */
const sameEditorSelection = (a: EditorSelectionContext | null, b: EditorSelectionContext) =>
  !!a &&
  a.path === b.path &&
  a.ranges.length === b.ranges.length &&
  a.ranges.every(
    (r, i) => r.startOffset === b.ranges[i]?.startOffset && r.endOffset === b.ranges[i]?.endOffset,
  );

/** The width of an element, kept current as panels open, close and resize. */
function useWidth() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!element) return;
    observer.current = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.current.observe(element);
  }, []);
  return [width, ref] as const;
}
/** The editor keeps at least this much room; the PDF and the comment margin give way first. */
const EDITOR_MIN = 380,
  MARGIN_WIDTH = 288;

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

/** The project's name in the header; its owner clicks it to rename the project, as on Overleaf. */
function ProjectTitle({
  name,
  canRename,
  onRename,
}: {
  name: string;
  canRename: boolean;
  onRename: (name: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<string | null>(null);
  if (!canRename)
    return (
      <div className="truncate text-sm font-medium" title={name}>
        {name}
      </div>
    );
  if (editing === null)
    return (
      <button
        type="button"
        className="group flex min-w-0 items-center gap-1 px-1 py-0.5 text-sm font-medium hover:bg-accent-hover"
        title={t("shell.renameProject")}
        onClick={() => setEditing(name)}
      >
        <span className="truncate">{name}</span>
        <PencilSimpleIcon
          className="size-3.5 shrink-0 text-muted opacity-0 group-hover:opacity-100"
          aria-hidden="true"
        />
      </button>
    );
  const finish = (save: boolean) => {
    const next = editing.trim();
    setEditing(null);
    if (save && next && next !== name) onRename(next);
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field appears because the owner asked to rename.
      autoFocus
      aria-label={t("shell.renameProject")}
      className="h-7 w-64 min-w-0 border border-border px-1.5 text-sm font-medium outline-none focus:border-foreground"
      value={editing}
      maxLength={120}
      onChange={(event) => setEditing(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
    />
  );
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
  const { t, locale } = useI18n();
  const prefix = `/projects/${project.id}`;
  // The tabs and the file in front come back on the next visit (this browser only).
  const tabsKey = `writer-tabs:${project.id}`;
  const [savedTabs] = useState<{ open: string[]; active: string | null }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(tabsKey) || "null");
      if (saved && Array.isArray(saved.open))
        return {
          open: saved.open.filter((id: unknown): id is string => typeof id === "string"),
          active: typeof saved.active === "string" ? saved.active : null,
        };
    } catch {
      /* Start with the main file. */
    }
    return { open: [], active: null };
  });
  const [role, setRole] = useState<Role>(project.role),
    [status, setStatus] = useState<SyncStatus>("connecting"),
    [notice, setNotice] = useState(""),
    [openIds, setOpenIds] = useState<string[]>(savedTabs.open),
    [activeId, setActiveId] = useState<string | null>(savedTabs.active),
    [peers, setPeers] = useState<Peer[]>([]),
    [text, setText] = useState<{ file: string; value: string } | null>(null);
  const narrow = useNarrow();
  const [editorSettings] = useEditorSettings();
  const [sidebar, setSidebar] = useState(!narrow),
    [sidebarTab, setSidebarTab] = useState<"files" | "history">("files"),
    // Files, editor, PDF and AI all start open on a wide screen, so a member sees at once
    // where to write, what it gives, and whom to ask.
    [rightOpen, setRightOpen] = useState(!narrow),
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
  const [draft, setDraft] = useDraft(
    `writer-note-draft:${user.id}:${project.id}`,
    setError,
    t("workspace.draftNotSaved"),
  );
  // The review margin follows the file (shown when it has comments) until the member opens or
  // closes it themselves; that choice is remembered.
  const [reviewChoice, setReviewChoice] = useState<boolean | null>(() => {
    try {
      const saved = localStorage.getItem("writer-web-review-choice");
      return saved === "open" ? true : saved === "closed" ? false : null;
    } catch {
      return null;
    }
  });
  const [activeComment, setActiveComment] = useState<string | null>(null),
    [selected, setSelected] = useState<{ from: number; to: number } | null>(null),
    [pdfNavigation, setPdfNavigation] = useState(0);
  // The selection the next AI message quotes, and work handed to the AI from elsewhere.
  const [aiSelection, setAiSelection] = useState<EditorSelectionContext | null>(null),
    [aiTask, setAiTask] = useState<AiTask | null>(null);
  const layout = useMemo<MarginLayout>(() => ({ view: null, events: new EventTarget() }), []);
  useEffect(() => {
    try {
      if (reviewChoice !== null)
        localStorage.setItem("writer-web-review-choice", reviewChoice ? "open" : "closed");
    } catch {
      /* The choice lasts for this visit only. */
    }
  }, [reviewChoice]);
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
    // Until the list has loaded, the tabs remembered from the last visit stay as they are.
    if (!data.loaded) return;
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
  }, [data.files, data.loaded]);
  useEffect(() => {
    if (activeId) setOpenIds((list) => (list.includes(activeId) ? list : [...list, activeId]));
  }, [activeId]);
  useEffect(() => {
    // Before the file list has loaded, the saved tabs are not known to be gone yet.
    if (!data.loaded) return;
    try {
      localStorage.setItem(tabsKey, JSON.stringify({ open: openIds, active: activeId }));
    } catch {
      /* Remembered for this visit only. */
    }
  }, [tabsKey, openIds, activeId, data.loaded]);
  const file = data.files.find((f) => f.id === activeId) ?? null;
  const fileNoted =
    draft?.file === file?.id ||
    data.comments.some((c) => c.file === file?.id && !c.resolved && !c.pdf);
  const reviewOpen = reviewChoice ?? fileNoted;
  const setReviewOpen = (next: boolean | ((open: boolean) => boolean)) =>
    setReviewChoice(typeof next === "function" ? next(reviewOpen) : next);
  /** Working with a comment brings the margin back if the member had closed it. */
  const showReview = () => {
    if (reviewChoice === false) setReviewChoice(true);
  };
  const hints = useMemo(() => projectHints(data.sources, parseBib), [data.sources]);
  const hintsRef = useRef(hints);
  hintsRef.current = hints;
  // The name as it is now; a rename by anyone reaches every open page with the project data.
  const current = data.summary ? { ...project, name: data.summary.name } : project;
  useEffect(() => {
    const before = document.title;
    document.title = `${current.name} · Y-Writer`;
    return () => {
      document.title = before;
    };
  }, [current.name]);
  const ws: WorkspaceContext = {
    prefix,
    project: current,
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
      setSelected(null);
      if (narrow) setSidebar(false);
    },
    status,
    askAi:
      role === "owner" || role === "editor"
        ? (text) => {
            setAiTask({ id: Date.now(), text });
            setRightOpen(true);
          }
        : null,
  };
  const b = useBuild(ws, data.latestBuild, data.sources, data.loaded);
  const [centerWidth, centerRef] = useWidth();
  const activate = (id: string | null) => {
    setActiveComment(id);
    if (id && data.comments.find((c) => c.id === id)?.pdf) setPdfNavigation((n) => n + 1);
  };
  /**
   * Where the comment being written shows: the margin beside the text when there is room for
   * it, otherwise the comments panel, so starting one from the PDF always shows its box.
   */
  const showDraftPlace = () => {
    if (marginFits) showReview();
    else setCommentsOpen(true);
  };
  const commentOnSelection = () => {
    const s = editor.current?.selection();
    if (!s || !file) {
      setError(t("workspace.selectFirst"));
      return;
    }
    setDraft({ file: file.id, body: draft?.body ?? "", ...s });
    showDraftPlace();
  };
  const submitDraft = () =>
    draft &&
    run(async () => {
      const made = await postDraft(prefix, draft);
      setDraft(null);
      await data.reload();
      setActiveComment((made as { id: string }).id);
    });
  const locate = (c: { id: string; file: string; line: number | null }) => {
    const target = data.files.find((f) => f.id === c.file);
    if (target && c.line) b.openLocation(target.path, c.line);
    activate(c.id);
    if (!narrow) showReview();
  };
  // Comments made on the PDF are drawn on it again while it is the same build.
  const pdfNotes: PdfAnnotationHost = {
    items: data.comments
      .filter((c) => c.pdf)
      .map(
        (c): PdfAnnotation => ({
          id: c.id,
          pdf: OUTPUT_PDF,
          quote: c.quote,
          comment: c.body,
          style: c.pdf?.style ?? "highlight",
          marks: (c.pdf?.marks ?? []).map((m) => ({ ...m, pageWidth: 1, pageHeight: 1 })),
          fingerprint: c.pdf?.fingerprint ?? "",
          createdAt: c.created,
          resolved: c.resolved,
          source: null,
          mappingNote: "",
          resolution: "",
        }),
      ),
    draft,
    selectedId: activeComment,
    navigation: pdfNavigation,
    setOpen: setCommentsOpen,
    beginDraft: (selection) => {
      const build = b.build;
      if (!build) return;
      run(async () => {
        const next = await draftFromPdf(prefix, build.id, data.files, selection, (f) =>
          f.id === file?.id ? (editor.current?.text() ?? null) : null,
        );
        if (draft?.body.trim() && !next.body) next.body = draft.body;
        setDraft(next);
        const target = data.files.find((f) => f.id === next.file);
        if (target && target.id !== file?.id) ws.openFile(target);
        showDraftPlace();
      });
    },
  };
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
  const syncText = file && !file.binary ? t(statusKey[status]) : t("workspace.filePreview");
  const outlinePath = file?.path.endsWith(".tex") ? file.path : b.chosenMain || undefined;
  const pdfShown = b.open && !narrow;
  // The PDF shrinks, then the comment margin hides, before the editor gets too narrow to use.
  const pdfWidth = centerWidth
    ? Math.min(pdfSize.size, Math.max(260, centerWidth - EDITOR_MIN))
    : pdfSize.size;
  const editorWidth = centerWidth - (pdfShown ? pdfWidth : 0);
  const marginFits = !narrow && (!centerWidth || editorWidth >= EDITOR_MIN + MARGIN_WIDTH);
  const marginShown = reviewOpen && marginFits && !!file && !file.binary;
  const editorActions = file && !file.binary && (
    <>
      <button
        type="button"
        disabled={!ws.canComment}
        className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40"
        title={t("workspace.commentSelection")}
        onClick={commentOnSelection}
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
  const assistant = (
    <Suspense fallback={null}>
      <AgentsPanel
        project={project.id}
        user={user}
        memberRole={role}
        visible={rightOpen}
        selection={aiSelection}
        onSelectionDone={(sent) =>
          setAiSelection((current) =>
            !sent || sameEditorSelection(current, sent) ? null : current,
          )
        }
        task={aiTask}
        onTaskTaken={(id) => setAiTask((current) => (current?.id === id ? null : current))}
        onOpenFile={(path, line) => b.openLocation(path, line)}
        onError={setError}
      />
    </Suspense>
  );
  const center = file ? (
    file.binary ? (
      <BinaryPreview key={file.id} prefix={prefix} file={file} />
    ) : (
      <Editor
        key={file.id}
        project={project.id}
        file={file.id}
        settings={editorSettings}
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
        activeComment={activeComment}
        onCommentClick={(id) => {
          activate(id);
          if (narrow) setCommentsOpen(true);
          else showReview();
        }}
        onSelect={(next) => {
          setSelected(next);
          // A selection stays quoted for the AI until another replaces it or it is sent.
          if (next) setAiSelection({ project: project.id, path: file.path, ranges: [next.range] });
          else setAiSelection((old) => (old?.path === file.path ? null : old));
        }}
        onLayout={(view) => {
          layout.view = view;
          layout.events.dispatchEvent(new Event("layout"));
        }}
      />
    )
  ) : (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-accent-hover p-6 text-center">
      <h2 className="text-sm font-medium">{t("workspace.emptyTitle")}</h2>
      <p className="text-xs text-muted">{t("workspace.emptyLead")}</p>
    </div>
  );
  return (
    <WorkbenchLocale locale={locale}>
      <div className="flex h-dvh flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 text-xs sm:gap-3 sm:px-4">
          <button
            type="button"
            onClick={onBack}
            title={t("shell.backToProjects")}
            className="shrink-0"
          >
            <img src="/favicon.svg" alt="Y-Writer" className="size-7 lg:hidden" />
            <img
              src="/logo-small-light.svg"
              alt="Y-Writer"
              className="hidden h-7 w-auto lg:block"
            />
          </button>
          <span className="hidden text-border sm:inline">/</span>
          <ProjectTitle
            name={current.name}
            canRename={role === "owner"}
            onRename={(name) =>
              run(async () => {
                await api(prefix, { name }, "PATCH");
                await data.reload();
              })
            }
          />
          <span className="hidden shrink-0 border border-border px-1.5 py-0.5 text-[10px] tracking-wider text-muted 2xl:inline">
            {t(roleKey[role])}
          </span>
          <span
            role="status"
            title={syncText}
            className={`flex shrink-0 items-center gap-1.5 ${file && !file.binary ? SYNC_TONE[status] : "text-muted"}`}
          >
            <span className="size-2 bg-current" aria-hidden="true" />
            {/* Saved is the quiet state; a problem is spelled out wherever there is room. */}
            <span
              className={status === "saved" ? "sr-only 2xl:not-sr-only" : "sr-only lg:not-sr-only"}
            >
              {syncText}
            </span>
          </span>
          <span className="hidden sm:contents">
            <VersionStatus
              snapshots={data.snapshots}
              members={data.members}
              onOpen={() => {
                setSidebarTab("history");
                setSidebar(true);
              }}
            />
          </span>
          {peers.length > 0 && (
            <span
              className="hidden shrink-0 items-center gap-1 md:flex"
              title={`${t("shell.online", { count: peers.length })}: ${peers.map((p) => p.name).join(", ")}`}
            >
              {peers.slice(0, 4).map((p) => (
                <span
                  key={p.name}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-medium text-white"
                  style={{ background: p.color }}
                >
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
              ))}
              {peers.length > 4 && <span className="text-muted">+{peers.length - 4}</span>}
            </span>
          )}
          <div className="ml-auto flex h-8 shrink-0 items-center gap-1 sm:gap-2">
            <CommentsPanel
              ws={ws}
              comments={data.comments}
              open={commentsOpen}
              setOpen={setCommentsOpen}
              draft={draft}
              setDraft={setDraft}
              onSubmit={submitDraft}
              showDraft={!marginShown || draft?.file !== file?.id}
              onLocate={locate}
            />
            {pendingReview > 0 && (
              <Btn className="hidden h-8 md:inline-flex" onClick={() => setDialog("review")}>
                {t("shell.reviewCount", { count: pendingReview })}
              </Btn>
            )}
            <span className="hidden select-none text-lg text-border sm:inline">/</span>
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
              className="hidden sm:flex"
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
              pressed={reviewOpen}
              label={t("notes.toggleMargin")}
              onClick={() => setReviewOpen((v) => !v)}
              className="hidden md:flex"
            >
              <ChatsCircleIcon className="size-4" weight="bold" />
            </ToggleButton>
            <ToggleButton
              pressed={rightOpen}
              label={t("shell.toggleAi")}
              onClick={() => setRightOpen((v) => !v)}
            >
              <RobotIcon className="size-4" weight="bold" />
            </ToggleButton>
            <span className="hidden select-none text-lg text-border sm:inline">/</span>
            <CompileButton
              b={b}
              disabled={!ws.canComment || b.compiling || !b.texFiles.length || status === "saving"}
            />
            <WorkspaceMenu
              user={user}
              role={role}
              pendingReview={pendingReview}
              exportHref={`/api${prefix}/export`}
              desktopHref={`lmms-writer://open?server=${encodeURIComponent(location.origin)}&project=${encodeURIComponent(project.id)}`}
              onProjects={onBack}
              onReferences={() => setDialog("references")}
              onReview={() => setDialog("review")}
              onShare={() => setDialog("share")}
            />
            <button
              type="button"
              onClick={() => setDialog("share")}
              className="hidden h-8 shrink-0 items-center gap-1.5 border border-border px-2 hover:bg-accent-hover sm:flex"
            >
              <UsersIcon className="size-4" aria-hidden="true" />
              {t("shell.share")}
            </button>
          </div>
        </header>
        <div className="shrink-0 bg-background text-xs" aria-live="polite">
          {(error || notice) && (
            <div
              role={error ? "alert" : "status"}
              className={`flex items-start gap-2 border-b border-border px-3 py-1.5 ${error ? "text-red-600" : ""}`}
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
          <div ref={centerRef} className="flex w-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1">
              {narrow && b.open ? (
                <PdfPane ws={ws} b={b} notes={pdfNotes} onClose={() => b.setOpen(false)} />
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
                  {marginShown ? (
                    <div className="flex min-h-0 flex-1">
                      <div className="flex min-w-0 flex-1 flex-col">{center}</div>
                      <div style={{ width: MARGIN_WIDTH }} className="shrink-0">
                        <ReviewMargin
                          ws={ws}
                          layout={layout}
                          editor={editor.current}
                          comments={data.comments.filter((c) => c.file === file?.id)}
                          active={activeComment}
                          setActive={activate}
                          draft={draft?.file === file?.id ? draft : null}
                          setDraft={setDraft}
                          onSubmit={submitDraft}
                          selection={selected}
                          onAdd={commentOnSelection}
                          onClose={() => setReviewOpen(false)}
                        />
                      </div>
                    </div>
                  ) : (
                    center
                  )}
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
                    style={{ width: pdfWidth }}
                    className="flex min-w-0 shrink-0 flex-col border-l border-border"
                  >
                    <PdfPane ws={ws} b={b} notes={pdfNotes} onClose={() => b.setOpen(false)} />
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
                  <LogPanel ws={ws} b={b} onClose={() => setLogOpen(false)} />
                </div>
              </>
            )}
          </div>
          {rightOpen &&
            (narrow ? (
              overlay("right", assistant, () => setRightOpen(false))
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
                  {assistant}
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
    </WorkbenchLocale>
  );
}
