/**
 * The project workbench in the browser, laid out like Overleaf's editor and the desktop app: one
 * header row with the project, its save state, panel toggles, compiling and a menu; a rail of
 * icons at the left opening files, search, comments, versions, messages and settings beside
 * it; open-file tabs with the editor and the PDF; the build log below (the desktop's terminal)
 * and AI conversations on the right (the desktop's assistant). Phones get the side panels as
 * overlays.
 */
import {
  occurrenceBefore,
  type PdfAnnotation,
  type PdfAnnotationHost,
  pathSync,
  projectHints,
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
import type { Comment, FileInfo, Notice, ProjectSummary, PublicUser, Role } from "../../shared/api";
import { api, download, errorText } from "../api";
import { Editor, type EditorHandle, type Peer } from "../editor";
import { useDarkTheme, useEditorSettings } from "../editor-settings";
import { useI18n } from "../i18n";
import { InboxList, useInbox } from "../inbox";
import { roleKey, statusKey } from "../labels";
import type { SyncStatus } from "../provider";
import type { ShownChange } from "../tracked-changes";
import { useAction } from "../use-action";
import type { AiTask } from "./agents-panel";
import {
  type AiConversations,
  choiceLabel,
  NO_CONVERSATIONS,
  resolveChoice,
  useAiChoice,
} from "./ai-target";
import { commentsTask, currentCommentsTask } from "./ai-tasks";
import { BinaryPreview } from "./binary-preview";
import { useBuild } from "./build";
import { ChatPanel } from "./chat-panel";
import { useCommentOps } from "./comment-ops";
import { CommentsList } from "./comments-panel";
import type { WorkspaceContext } from "./context";
import { FilePanel } from "./file-panel";
import { GitDialog } from "./git-dialog";
import { CompileButton, SettingsPanel, VersionStatus, WorkspaceMenu } from "./header";
import { HistoryPanel } from "./history-panel";
import { LogPanel } from "./log-panel";
import { type BubbleState, NoteBubble, toggleBubble } from "./note-bubble";
import { draftFromPdf, useDraft } from "./notes";
import { OUTPUT_PDF, PdfPane } from "./pdf-pane";
import { ProjectSearchPanel } from "./project-search-panel";
import { Rail, type RailPanel } from "./rail";
import { ReferencesDialog } from "./references-dialog";
import { ReviewDialog } from "./review-dialog";
import { type MarginLayout, ReviewMargin } from "./review-margin";
import { ShareDialog } from "./share-dialog";
import { SymbolButton } from "./symbol-button";
import { TrackedButton } from "./tracked-button";
import { Btn, ResizeHandle, ToggleButton, useStoredSize } from "./ui";
import { CHAT_EVENT, useProject } from "./use-project";
import { WordCountDialog } from "./word-count-dialog";

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

/** The window's width, kept current. */
function useWindowWidth() {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const changed = () => setWidth(window.innerWidth);
    window.addEventListener("resize", changed);
    return () => window.removeEventListener("resize", changed);
  }, []);
  return width;
}
/** Below this width the AI panel opens over the editor rather than squeezing it. */
const AI_BESIDE = 1200;

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
  focusComment,
  onOpenNotice,
}: {
  project: ProjectSummary;
  user: PublicUser;
  onBack: () => void;
  /** A comment to show once the project has loaded (opened from a message). */
  focusComment?: string | null;
  /** Opens a message about another project. */
  onOpenNotice: (notice: Notice) => void;
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
  const windowWidth = useWindowWidth();
  const aiBeside = !narrow && windowWidth >= AI_BESIDE;
  const [editorSettings] = useEditorSettings();
  const dark = useDarkTheme(editorSettings.theme);
  // The workbench's colours follow the `dark` class (theme.css), on the whole page while open.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    return () => document.documentElement.classList.remove("dark");
  }, [dark]);
  // Code or visual mode, remembered in this browser.
  const [visual, setVisual] = useState(() => {
    try {
      return localStorage.getItem("writer-editor-visual") === "1";
    } catch {
      return false;
    }
  });
  const chooseVisual = (on: boolean) => {
    setVisual(on);
    try {
      localStorage.setItem("writer-editor-visual", on ? "1" : "0");
    } catch {}
  };
  // The rail's panel open beside it (null: closed); on phones it opens over the editor.
  const [panel, setPanel] = useState<RailPanel | null>(narrow ? null : "files"),
    // Files, editor, PDF and AI all start open on a wide screen, so a member sees at once
    // where to write, what it gives, and whom to ask; a laptop opens the AI when asked.
    [rightOpen, setRightOpen] = useState(aiBeside),
    [logOpen, setLogOpen] = useState(false),
    [dialog, setDialog] = useState<"share" | "references" | "review" | "count" | "git" | null>(
      null,
    );
  // Chat messages from others that arrived while the chat was closed.
  const [unreadChat, setUnreadChat] = useState(0);
  const chatOpen = useRef(false);
  chatOpen.current = panel === "chat";
  useEffect(() => {
    if (panel === "chat") setUnreadChat(0);
  }, [panel]);
  useEffect(() => {
    const arrived = (event: Event) => {
      const { detail } = event as CustomEvent<{ project: string; message: { author: string } }>;
      if (detail.project === project.id && detail.message.author !== user.id && !chatOpen.current)
        setUnreadChat((n) => n + 1);
    };
    window.addEventListener(CHAT_EVENT, arrived);
    return () => window.removeEventListener(CHAT_EVENT, arrived);
  }, [project.id, user.id]);
  // Smaller windows narrow the side panels first, leaving the editor and the PDF their room.
  const sidebarSize = useStoredSize(
      "writer-web-sidebar",
      280,
      200,
      560,
      Math.round(windowWidth * 0.19),
    ),
    rightSize = useStoredSize("writer-web-right", 380, 280, 720, Math.round(windowWidth * 0.27)),
    pdfSize = useStoredSize("writer-web-pdf", 560, 260, 1600),
    logSize = useStoredSize("writer-web-log", 220, 120, 640);
  const { busy, error, setError, run } = useAction();
  const data = useProject(prefix, { onRole: setRole, onError: setError });
  const ops = useCommentOps({ prefix, user, change: data.changeComments, report: setError });
  const { inbox, markRead } = useInbox();
  /** Opens a panel of the rail, or closes it when it is the one open. */
  const togglePanel = (next: RailPanel) => setPanel((open) => (open === next ? null : next));
  // Track changes: on for everyone, or per member; the open file's changes for the toolbar.
  const trackAll = data.summary?.trackAll === true;
  const [trackedChanges, setTrackedChanges] = useState<ShownChange[]>([]);
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
    [aiTask, setAiTask] = useState<AiTask | null>(null),
    [conversations, setConversations] = useState<AiConversations>(NO_CONVERSATIONS);
  const [aiChoice, setAiChoice] = useAiChoice(project.id);
  // The sticky note open beside the text or the PDF.
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const closeBubble = useCallback(() => setBubble(null), []);
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
      setPanel(null);
      setRightOpen(false);
    }
  }, [narrow]);
  // A window made too small for the AI beside the editor closes it rather than covering it.
  useEffect(() => {
    if (!aiBeside) setRightOpen(false);
  }, [aiBeside]);
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
      if (narrow) setPanel(null);
    },
    status,
    askAi:
      role === "owner" || role === "editor"
        ? (text, notes) => {
            const target = resolveChoice(aiChoice, conversations);
            const label = choiceLabel(aiChoice, conversations, t);
            run(async () => {
              const current = notes?.length
                ? await currentCommentsTask(notes, data.files, locale, () =>
                    api<Comment[]>(`${prefix}/comments`),
                  )
                : text;
              setAiTask({ id: Date.now(), text: current, target });
              if (notes?.length) ops.handoff(notes, label);
              setRightOpen(true);
            });
          }
        : null,
    ai: { choice: aiChoice, setChoice: setAiChoice, conversations },
    members: data.members,
    comments: ops,
  };
  const b = useBuild(ws, data.latestBuild, data.sources, data.loaded);
  const fileIssues = useMemo(
    () =>
      (b.build?.issues ?? [])
        // LaTeX warnings name a line but no file: the main file's.
        .filter((i) => i.line && (i.file ?? b.build?.main) === file?.path)
        .map((i) => ({ line: i.line as number, level: i.level, message: i.message })),
    [b.build, file?.path],
  );
  const [centerWidth, centerRef] = useWidth();
  const activate = (id: string | null) => {
    setActiveComment(id);
    // The PDF shows it too (made there, or its text found there).
    if (id) setPdfNavigation((n) => n + 1);
  };
  /**
   * Where the comment being written shows: the margin beside the text when there is room for
   * it, otherwise the comments panel, so starting one from the PDF always shows its box.
   */
  const showDraftPlace = () => {
    if (marginFits) showReview();
    else setPanel("comments");
  };
  const commentOnSelection = () => {
    const s = editor.current?.selection();
    if (!s || !file) {
      setError(t("workspace.selectFirst"));
      return;
    }
    setDraft({ file: file.id, body: draft?.body ?? "", ...s });
    setBubble({ kind: "draft", where: "editor" });
  };
  /**
   * Posts the comment being written; `andAsk` hands it to the chosen AI conversation too. It
   * shows at once (the note stays open, now on the comment); a refusal brings the draft back.
   */
  const submitDraft = (andAsk = false) => {
    if (!draft) return;
    const posting = draft;
    const here = posting.file === file?.id ? editor.current : null;
    const text = here?.text() ?? null;
    const place = {
      line: text === null ? null : text.slice(0, posting.from).split("\n").length,
      ...(posting.start ? {} : (here?.anchor(posting.from, posting.to) ?? {})),
    };
    setError("");
    const { id, done } = ops.post(posting, place);
    // The note stays open, now on the comment.
    const where = bubble?.kind === "draft" ? bubble.where : null;
    if (where) setBubble({ kind: "notes", ids: [id], where });
    setDraft(null);
    setActiveComment(id);
    void done.then((made) => {
      if (!made) {
        // Refused: the words come back to try again.
        setDraft((now) => now ?? posting);
        if (where) setBubble({ kind: "draft", where });
        return;
      }
      if (andAsk && ws.askAi) ws.askAi(commentsTask([made], data.files, locale), [made.id]);
    });
  };
  /** A comment someone was told about: its text, with the note open beside it. */
  const showComment = (c: Comment) => {
    locate(c);
    if (narrow || !c.line) setPanel("comments");
    else setBubble({ kind: "notes", ids: [c.id], where: "editor" });
  };
  const locate = (c: { id: string; file: string; line: number | null }) => {
    const target = data.files.find((f) => f.id === c.file);
    if (target && c.line) b.openLocation(target.path, c.line);
    activate(c.id);
    if (!narrow) showReview();
  };
  // A comment opened from a message is shown once the project has loaded.
  const focused = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the comment first appears.
  useEffect(() => {
    if (!focusComment || focused.current || !data.loaded) return;
    const target = data.comments.find((c) => c.id === focusComment);
    if (!target) return;
    focused.current = true;
    showComment(target);
  }, [focusComment, data.loaded, data.comments]);
  // Every comment is drawn on the PDF: where it was made on this build, or wherever its text
  // is found in the build shown (comments made in the editor appear without compiling).
  const editorText = text;
  const pdfItems = useMemo(() => {
    const sourceOf = (id: string) => {
      const path = data.files.find((f) => f.id === id)?.path;
      if (editorText && editorText.file === path) return editorText.value;
      return data.sources.find((f) => f.id === id)?.content ?? null;
    };
    return data.comments.flatMap((c): PdfAnnotation[] => {
      const excerpt = c.excerpt ?? (c.pending ? c.quote : null);
      if (!c.pdf && (c.from === null || !excerpt)) return [];
      const content = sourceOf(c.file);
      return [
        {
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
          locate:
            excerpt && c.from !== null
              ? {
                  text: excerpt,
                  occurrence: content ? occurrenceBefore(content, c.from, excerpt) : 0,
                }
              : null,
        },
      ];
    });
  }, [data.comments, data.files, data.sources, editorText]);
  // Comments made on the PDF are drawn on it again while it is the same build.
  const pdfNotes: PdfAnnotationHost = {
    items: pdfItems,
    draft,
    selectedId: activeComment,
    navigation: pdfNavigation,
    setOpen: (open) => setPanel(open ? "comments" : null),
    openNotes: (ids) => {
      activate(ids[0] ?? null);
      setBubble((open) => toggleBubble(open, { kind: "notes", ids, where: "pdf" }));
    },
    beginDraft: (selection) => {
      const build = b.build;
      if (!build) return;
      // The note opens at once where the words were selected on the PDF, while their place in
      // the source is looked up (Post waits for it).
      const chosen = document.getSelection();
      const rect = chosen?.rangeCount ? chosen.getRangeAt(0).getBoundingClientRect() : null;
      const typed = draft?.body.trim() ? draft.body : "";
      setDraft({ file: "", quote: selection.quote, body: typed, from: 0, to: 0 });
      if (rect && rect.height > 0) setBubble({ kind: "draft", where: "pdf", rect });
      else showDraftPlace();
      void draftFromPdf(prefix, build.id, data.files, selection, (f) =>
        f.id === file?.id ? (editor.current?.text() ?? null) : null,
      )
        .then((next) => {
          setDraft((now) =>
            now && !now.file && now.quote === selection.quote
              ? { ...next, body: now.body || next.body }
              : now,
          );
          const target = data.files.find((f) => f.id === next.file);
          if (target && target.id !== file?.id) ws.openFile(target);
        })
        .catch((e) => {
          setError(errorText(e));
          setDraft((now) => (now && !now.file ? null : now));
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
      // Search the whole project, as on Overleaf.
      if (mod && event.shiftKey && key === "f") {
        event.preventDefault();
        setPanel("search");
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
      <SymbolButton ws={ws} />
      <TrackedButton ws={ws} changes={trackedChanges} trackAll={trackAll} members={data.members} />
      <button
        type="button"
        disabled={!ws.canComment}
        className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40"
        title={t("workspace.commentSelection")}
        onClick={commentOnSelection}
      >
        <ChatCircleTextIcon className="size-3.5" />
        <span className="hidden @2xl:inline">{t("workspace.commentSelection")}</span>
      </button>
      {b.build?.pdf && (
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground"
          title={t("build.forwardTitle")}
          onClick={b.showCursorInPdf}
        >
          <CrosshairIcon className="size-3.5" />
          <span className="hidden @2xl:inline">{t("build.forward")}</span>
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
  /** A message: this project's opens the comment; another project's opens that project. */
  const openNotice = (notice: Notice) => {
    markRead([notice.id]);
    if (notice.project !== project.id) {
      onOpenNotice(notice);
      return;
    }
    const target = data.comments.find((c) => c.id === notice.comment);
    if (!target) {
      setPanel("comments");
      return;
    }
    showComment(target);
  };
  const panelContent =
    panel === "files" ? (
      <FilePanel
        ws={ws}
        outlinePath={outlinePath}
        outlineSource={text && text.file === outlinePath ? text.value : undefined}
        onOutline={(path, line) => b.openLocation(path, line)}
      />
    ) : panel === "search" ? (
      <ProjectSearchPanel
        ws={ws}
        refresh={data.refreshSources}
        onOpen={(path, line) => b.openLocation(path, line)}
      />
    ) : panel === "comments" ? (
      <CommentsList
        ws={ws}
        comments={data.comments}
        draft={draft}
        setDraft={setDraft}
        onSubmit={submitDraft}
        showDraft={bubble?.kind !== "draft" && (!marginShown || draft?.file !== file?.id)}
        onLocate={locate}
      />
    ) : panel === "chat" ? (
      <ChatPanel ws={ws} />
    ) : panel === "history" ? (
      <HistoryPanel ws={ws} snapshots={data.snapshots} />
    ) : panel === "inbox" ? (
      <section aria-label={t("inbox.title")} className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <strong>{t("inbox.title")}</strong>
        </header>
        <InboxList
          inbox={inbox}
          project={project.id}
          onOpen={openNotice}
          onReadAll={() => markRead()}
        />
      </section>
    ) : panel === "settings" ? (
      <SettingsPanel />
    ) : null;
  const rail = (
    <Rail
      panel={panel}
      onPanel={togglePanel}
      openComments={data.comments.filter((c) => !c.resolved).length}
      unread={inbox?.unread ?? 0}
      unreadChat={unreadChat}
      pendingReview={pendingReview}
      onReferences={() => setDialog("references")}
      onWordCount={() => setDialog("count")}
      onReview={() => setDialog("review")}
    />
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
        onConversations={setConversations}
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
        spellcheck={editorSettings.spellcheck && /\.(tex|ltx)$/i.test(file.path)}
        tracking={trackAll || data.members.some((m) => m.id === user.id && m.tracking)}
        onChanges={setTrackedChanges}
        visual={visual}
        onVisualChange={chooseVisual}
        issues={fileIssues}
        dark={dark}
        resolveImage={(path) => {
          // As TeX looks: from the project's top and beside the file, with or without extension.
          const folder = file.path.includes("/")
            ? file.path.slice(0, file.path.lastIndexOf("/") + 1)
            : "";
          const names = [path, `${folder}${path}`].flatMap((name) =>
            ["", ".png", ".jpg", ".jpeg", ".pdf", ".svg", ".gif", ".webp"].map((ext) => name + ext),
          );
          const found = names.map((name) => data.files.find((f) => f.path === name)).find(Boolean);
          return found?.binary ? `/api${prefix}/files/${found.id}/raw?r=${found.revision}` : null;
        }}
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
          if (narrow) setPanel("comments");
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
        draftAt={draft?.file === file.id ? draft.from : null}
        onNoteIcon={(ids, isDraft) => {
          if (!isDraft) activate(ids[0] ?? null);
          setBubble((open) =>
            toggleBubble(
              open,
              isDraft
                ? { kind: "draft", where: "editor" }
                : { kind: "notes", ids, where: "editor" },
            ),
          );
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
              src={dark ? "/logo-dark.svg" : "/logo-small-light.svg"}
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
              onOpen={() => setPanel("history")}
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
            {pendingReview > 0 && (
              <Btn className="hidden h-8 md:inline-flex" onClick={() => setDialog("review")}>
                {t("shell.reviewCount", { count: pendingReview })}
              </Btn>
            )}
            {/* Phones have no rail: this opens it, with its panel, over the editor. */}
            {narrow && (
              <ToggleButton
                pressed={panel !== null}
                label={t("shell.toggleSidebar")}
                onClick={() => setPanel((open) => (open ? null : "files"))}
                className="relative"
              >
                <SidebarSimpleIcon className="size-4" weight="bold" />
                {(inbox?.unread ?? 0) > 0 && (
                  <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-sky-500" />
                )}
              </ToggleButton>
            )}
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
              exportHref={`/api${prefix}/export`}
              desktopHref={`lmms-writer://open?server=${encodeURIComponent(location.origin)}&project=${encodeURIComponent(project.id)}`}
              onProjects={onBack}
              onShare={() => setDialog("share")}
              onGit={() => setDialog("git")}
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
          {narrow ? (
            panel &&
            overlay(
              "left",
              <div className="flex min-h-0 flex-1">
                {rail}
                <div className="flex min-w-0 flex-1 flex-col">{panelContent}</div>
              </div>,
              () => setPanel(null),
            )
          ) : (
            <>
              {rail}
              {panel && (
                <>
                  <aside
                    key={panel}
                    style={{ width: Math.max(sidebarSize.size, panel === "comments" ? 320 : 0) }}
                    className="slide-in-left flex shrink-0 flex-col overflow-hidden border-r border-border"
                  >
                    {panelContent}
                  </aside>
                  <ResizeHandle
                    label={t("shell.resizeSidebar")}
                    onResize={sidebarSize.resize}
                    onDone={sidebarSize.save}
                  />
                </>
              )}
            </>
          )}
          <div ref={centerRef} className="flex w-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1">
              {narrow && b.open ? (
                <div className="flex min-w-0 flex-1 flex-col">
                  <PdfPane ws={ws} b={b} notes={pdfNotes} onClose={() => b.setOpen(false)} />
                </div>
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
                          draft={
                            bubble?.kind !== "draft" && draft?.file === file?.id ? draft : null
                          }
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
            (!aiBeside ? (
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
        {bubble && (
          <NoteBubble
            ws={ws}
            state={bubble}
            comments={data.comments}
            draft={draft}
            setDraft={setDraft}
            onSubmit={submitDraft}
            onClose={closeBubble}
          />
        )}
        {dialog === "share" && (
          <ShareDialog
            ws={ws}
            members={data.members}
            onClose={() => setDialog(null)}
            onDeleted={onBack}
          />
        )}
        {dialog === "git" && <GitDialog ws={ws} onClose={() => setDialog(null)} />}
        {dialog === "references" && (
          <ReferencesDialog
            ws={ws}
            sources={data.sources}
            refreshSources={data.refreshSources}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === "count" && (
          <WordCountDialog
            ws={ws}
            main={b.chosenMain}
            sources={data.sources}
            refresh={data.refreshSources}
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
