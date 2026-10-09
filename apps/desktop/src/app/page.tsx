"use client";

import type { ConversationTarget } from "@lmms-lab/workbench/agents";
import {
  ChatImageDirectory,
  type EditorSelectionContext,
  type EditorTextRange,
  flushComposerDrafts,
  isHarnessId,
  isWriterManagedPath,
  parseChatLink,
  sameEditorSelection,
} from "@lmms-lab/workbench/agents";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OpenFromServer } from "@/components/collab/open-from-server";
import { SyncPanel } from "@/components/collab/sync-panel";
import {
  type DockviewPanelItem,
  DockviewPanelLayout,
} from "@/components/editor/dockview-panel-layout";
import { EditorErrorBoundary } from "@/components/editor/editor-error-boundary";
import { EditorSkeleton } from "@/components/editor/editor-skeleton";
import { GitHubPublishDialog } from "@/components/editor/github-publish-dialog";
import { SaveStatus } from "@/components/editor/save-status";
import { FileSidebarPanel } from "@/components/editor/sidebar-file-panel";
import { GitSidebarPanel } from "@/components/editor/sidebar-git-panel";
import { TerminalPanel } from "@/components/editor/terminal-panel";
import { HarnessButtons, HarnessWorkspace } from "@/components/harness/workspace";
import { LaTeXInstallPrompt, LaTeXSettingsDialog, SynctexInstallDialog } from "@/components/latex";
import { BuildTargetsEditor } from "@/components/latex/build-targets-editor";
import { TemplateImportDialog } from "@/components/latex/template-import-dialog";
import { RecentProjects } from "@/components/recent-projects";
import { InputDialog } from "@/components/ui/input-dialog";
import {
  TabBar,
  type TabDragEndPayload,
  type TabDragMovePayload,
  type TabItem,
  type TabReorderPosition,
} from "@/components/ui/tab-bar";
import { useToast } from "@/components/ui/toast";
import { linkedFolders } from "@/lib/collab/accounts";
import { useSharedRunner } from "@/lib/collab/runner";
import { TeamCommentsProvider } from "@/lib/collab/team-comments";
import { useFolderSync } from "@/lib/collab/use-folder-sync";
import { useEditorSettings } from "@/lib/editor";
import { fileKind, fileLanguage } from "@/lib/editor/file-kind";
import { buildFileIndex, resolveFileReference } from "@/lib/editor/file-resolution";
import { ProjectTransition } from "@/lib/editor/project-transition";
import { projectRelativePath } from "@/lib/editor/save-manager";
import { useAgentDelivery } from "@/lib/editor/use-agent-delivery";
import { useDocumentSaving } from "@/lib/editor/use-document-saving";
import { usePanelResize } from "@/lib/editor/use-panel-resize";
import { getReadableErrorMessage, getSynctexLookupMessage } from "@/lib/errors";
import { resolveLocalFile, revealInFileManager } from "@/lib/file-manager";
import { parseUnifiedDiffContent } from "@/lib/git/unified-diff";
import { useGitActions } from "@/lib/git/use-git-actions";
import { useHarnessWorkspace } from "@/lib/harness/use-workspace";
import { useI18n } from "@/lib/i18n";
import { findTexFiles, useLatexCompiler, useLatexSettings } from "@/lib/latex";
import { compileFailurePrompt } from "@/lib/latex/compile-failure";
import type { BuildTarget, SynctexResult, TargetBuildResult } from "@/lib/latex/types";
import { useTargetBuild } from "@/lib/latex/use-target-build";
import { useOpenCodeDaemon } from "@/lib/opencode/use-opencode-daemon";
import { pathSync } from "@/lib/path";
import { AnnotationProvider } from "@/lib/pdf/annotation-context";
import { annotationPrompt } from "@/lib/pdf/annotations";
import { useRecentProjects } from "@/lib/recent-projects";
import { useTauriDaemon } from "@/lib/tauri";
import { throttle } from "@/lib/timing";

const PdfViewer = dynamic(
  () => import("@/components/editor/pdf-viewer").then((mod) => mod.PdfViewer),
  { ssr: false },
);

import {
  AppWindowIcon,
  FolderOpenIcon,
  GearIcon,
  PlayCircleIcon,
  RobotIcon,
  SidebarSimpleIcon,
  TerminalIcon,
} from "@phosphor-icons/react";
import { listenHere } from "@/lib/tauri/window-events";

type EditorViewMode = "file" | "git-diff";
type GitDiffPreviewState = {
  path: string;
  staged: boolean;
  content: string;
  isLoading: boolean;
  error: string | null;
};

type SplitPaneSide = "left" | "right";
type DragSourcePane = "primary" | "split";

type SplitPaneState = {
  side: SplitPaneSide;
  openTabs: string[];
  selectedFile?: string;
  content: string;
  isLoading: boolean;
  error: string | null;
  binaryPreviewUrl: string | null;
  pdfRefreshKey: number;
};

const MonacoEditor = dynamic(
  () => import("@/components/editor/monaco-editor").then((mod) => mod.MonacoEditor),
  { ssr: false },
);

const GitMonacoDiffEditor = dynamic(
  () => import("@/components/editor/monaco-diff-editor").then((mod) => mod.MonacoDiffEditor),
  {
    ssr: false,
    loading: () => <EditorSkeleton className="h-full" />,
  },
);

const OpenCodeDisconnectedDialog = dynamic(
  () =>
    import("@/components/opencode/opencode-disconnected-dialog").then(
      (mod) => mod.OpenCodeDisconnectedDialog,
    ),
  { ssr: false },
);

const OpenCodeErrorDialog = dynamic(
  () =>
    import("@/components/opencode/opencode-error-dialog").then((mod) => mod.OpenCodeErrorDialog),
  { ssr: false },
);

export default function EditorPage() {
  const editorSettings = useEditorSettings();
  const daemon = useTauriDaemon({
    gitAutoFetchEnabled: editorSettings.settings.gitAutoFetchEnabled,
    gitAutoFetchIntervalMs: editorSettings.settings.gitAutoFetchIntervalSeconds * 1000,
  });
  const prefersReducedMotion = useReducedMotion();
  const { toast } = useToast();
  const { t, locale } = useI18n();
  // The backend and collaboration servers word their messages in the interface language.
  useEffect(() => {
    void invoke("set_locale", { locale }).catch(() => {});
  }, [locale]);
  const recentProjects = useRecentProjects();
  const [projectTransition] = useState(() => new ProjectTransition());
  const [choosingProject, setChoosingProject] = useState(false);
  const [switchingProject, setSwitchingProject] = useState(false);

  const [selectedFile, setSelectedFile] = useState<string>();
  const [fileContent, setFileContent] = useState<string>("");
  const [editorSelection, setEditorSelection] = useState<EditorSelectionContext | null>(null);
  const handleEditorSelection = useCallback(
    (project: string | null, path: string | undefined, ranges: EditorTextRange[] | null) => {
      if (!project || !path) return;
      setEditorSelection((previous) => {
        if (!ranges?.length)
          return previous?.project === project && previous.path === path ? null : previous;
        const next = { project, path, ranges };
        return sameEditorSelection(previous, next) ? previous : next;
      });
    },
    [],
  );
  useEffect(() => {
    setEditorSelection((selection) =>
      selection?.project === daemon.projectPath ? selection : null,
    );
  }, [daemon.projectPath]);
  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>("file");
  const [gitDiffPreview, setGitDiffPreview] = useState<GitDiffPreviewState | null>(null);
  const [splitPane, setSplitPane] = useState<SplitPaneState | null>(null);
  const [splitDropHint, setSplitDropHint] = useState<SplitPaneSide | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [binaryPreviewUrl, setBinaryPreviewUrl] = useState<string | null>(null);
  const [pdfRefreshKey, setPdfRefreshKey] = useState(0);
  const [pendingGoToLine, setPendingGoToLine] = useState(0);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const conversations = useHarnessWorkspace(daemon.projectPath);
  const opencode = useOpenCodeDaemon(
    daemon.projectPath,
    conversations.tabs.some((t) => t.backend === "opencode"),
  );
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  /** Drafts are persisted; running or approval-waiting agents need explicit consent. */
  const confirmAgentsIdle = useCallback(
    async (action: "switch" | "close" | "quit") => {
      const busy = conversationsRef.current.tabs.filter(
        (tab) => tab.status === "running" || tab.status === "waiting",
      );
      if (!busy.length) return true;
      const names =
        busy
          .slice(0, 3)
          .map((tab) => t("page.quotedTitle", { title: tab.title }))
          .join(t("page.listSeparator")) +
        (busy.length > 3 ? t("page.andCountMore", { count: busy.length }) : "");
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const text = {
        quit: ["page.namesCountIsAreStillRunningOrWaitingForA", "page.quitWriter"],
        switch: ["page.namesCountIsAreStillRunningOrWaitingForA2", "page.switchProject"],
        close: ["page.agentsBusyCloseWindow", "page.closeWindow"],
      } as const;
      const [message, title] = text[action];
      return ask(t(message, { names, count: busy.length }), { title: t(title), kind: "warning" });
    },
    [t],
  );
  const [agentBackend, setAgentBackend] = useState<"opencode" | "codex" | "claude">(() => {
    if (typeof window === "undefined") return "opencode";
    const stored = localStorage.getItem("lmms-writer-agent-backend");
    return stored === "codex" || stored === "claude" ? stored : "opencode";
  });
  const activeHarness = conversations.tabs.find(
    (tab) => tab.id === conversations.activeId,
  )?.backend;
  useEffect(() => {
    if (activeHarness) setAgentBackend(activeHarness);
  }, [activeHarness]);
  const [showTerminal, setShowTerminal] = useState(false);
  const { sidebarWidth, rightPanelWidth, resizing, startResize, handleResizeDrag, endResize } =
    usePanelResize();
  const [sidebarTab, setSidebarTab] = useState<"files" | "git">("files");
  const [highlightedFile, _setHighlightedFile] = useState<string | null>(null);

  const [createDialog, setCreateDialog] = useState<{
    type: "file" | "directory";
  } | null>(null);
  const saving = useDocumentSaving((quit) => confirmAgentsIdle(quit ? "quit" : "close"));
  const saveManager = saving.manager;
  const { prepareEditorMessage } = useAgentDelivery(saveManager, daemon.projectPath);

  const primaryLoadRequestIdRef = useRef(0);
  const [fileLoadError, setFileLoadError] = useState<string | null>(null);
  const flushBeforeLeave = useCallback(async () => {
    try {
      await saveManager.flushAll();
      return true;
    } catch (error) {
      toast(t("page.savingFailedTheActionWasCancelledError", { error: String(error) }), "error");
      return false;
    }
  }, [saveManager, toast, t]);
  useEffect(() => {
    const project = daemon.projectPath;
    if (!project) return;
    void saveManager
      .recoverProject(project, (path) => invoke<string>("read_document", { project, path }))
      .catch((error) =>
        toast(t("page.couldNotReadRecoveredDraftsError", { error: String(error) }), "error"),
      );
  }, [daemon.projectPath, saveManager, toast, t]);
  const [showLatexSettings, setShowLatexSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"build" | "editor" | "collab">("build");
  const openSettings = useCallback((tab: "build" | "editor" | "collab" = "build") => {
    setSettingsTab(tab);
    setShowLatexSettings(true);
  }, []);
  /** false: closed; otherwise open, optionally preselecting a project from a web link. */
  const [openFromServer, setOpenFromServer] = useState<
    false | { server: string; project: string } | null
  >(false);
  const [pendingBackend, setPendingBackend] = useState<"opencode" | "codex" | "claude">("opencode");
  const [pendingOpenCodeMessage, setPendingOpenCodeMessage] = useState<string | null>(null);

  const [showSynctexInstallDialog, setShowSynctexInstallDialog] = useState(false);
  const pendingSynctexRetryRef = useRef<{
    page: number;
    x: number;
    y: number;
    context: "main" | "split";
  } | null>(null);

  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const gitDiffRequestIdRef = useRef(0);
  const splitLoadRequestIdRef = useRef(0);
  const editorWorkspaceRef = useRef<HTMLDivElement | null>(null);

  const gitStatus = daemon.gitStatus;
  const git = useGitActions({ daemon, flush: flushBeforeLeave, ensureOpenCode: opencode.ensure });
  const folderSync = useFolderSync(daemon.projectPath);
  const sharedRunner = useSharedRunner(folderSync.link);

  // LaTeX settings and editor settings
  const latexSettings = useLatexSettings(daemon.projectPath);
  const [showTemplateImport, setShowTemplateImport] = useState(false);
  const texFiles = useMemo(() => findTexFiles(daemon.files), [daemon.files]);

  const latexCompiler = useLatexCompiler({
    settings: latexSettings.settings,
    projectPath: daemon.projectPath,
  });

  // Check if any LaTeX compiler is available
  const hasAnyCompiler =
    latexCompiler.compilersStatus &&
    (latexCompiler.compilersStatus.pdflatex.available ||
      latexCompiler.compilersStatus.xelatex.available ||
      latexCompiler.compilersStatus.lualatex.available ||
      latexCompiler.compilersStatus.latexmk.available ||
      latexCompiler.compilersStatus.tectonic.available);

  const handOffBuildFailure = useCallback(
    async (target: BuildTarget, result: TargetBuildResult) => {
      if (!daemon.projectPath) return;
      setPendingBackend(agentBackend);
      setPendingOpenCodeMessage(
        compileFailurePrompt({
          projectPath: daemon.projectPath,
          target,
          result,
          backend: agentBackend,
        }),
      );
      setShowRightPanel(true);
      if (agentBackend !== "opencode") {
        toast(
          agentBackend === "codex"
            ? t("page.compilationFailedTheLogWasSentToCodex")
            : t("page.compilationFailedTheLogIsInTheClaudeCode"),
          "error",
        );
        return;
      }
      const ready = await opencode.ensure(daemon.projectPath);
      toast(
        ready
          ? t("page.compilationFailedSentTheLogToAgent")
          : t("page.compilationFailedCouldNotStartTheAgentAu"),
        "error",
      );
    },
    [agentBackend, daemon.projectPath, opencode.ensure, toast, t],
  );
  const showBuiltPdf = useCallback(
    ({ relative, absolute }: { relative: string; absolute: string }) => {
      setEditorViewMode("file");
      setGitDiffPreview(null);
      setOpenTabs((prev) => (prev.includes(relative) ? prev : [...prev, relative]));
      setSelectedFile(relative);
      setBinaryPreviewUrl(convertFileSrc(absolute));
      setFileContent("");
      setPdfRefreshKey((key) => key + 1);
      void daemon.refreshFiles();
    },
    [daemon],
  );
  const targetBuild = useTargetBuild({
    projectPath: daemon.projectPath,
    prepare: flushBeforeLeave,
    onBuilt: showBuiltPdf,
    onFailed: handOffBuildFailure,
  });
  const handleCompileWithDetection = useCallback(async () => {
    if (!daemon.projectPath || latexSettings.isDetecting || latexSettings.saving) return;
    const target = latexSettings.activeTarget;
    if (target) {
      await targetBuild.build(target);
      return;
    }
    setShowLatexSettings(true);
    toast(t("page.addOrScanBuildTargetsInSettings"), "error");
  }, [
    daemon.projectPath,
    latexSettings.isDetecting,
    latexSettings.saving,
    latexSettings.activeTarget,
    targetBuild.build,
    toast,
    t,
  ]);

  const handleToggleRightPanel = useCallback(() => {
    setShowRightPanel((open) => !open);
  }, []);

  const initializedAgentPanelProject = useRef<string | null>(null);
  useEffect(() => {
    if (!daemon.projectPath) {
      initializedAgentPanelProject.current = null;
      return;
    }
    if (
      showRightPanel &&
      conversations.ready &&
      initializedAgentPanelProject.current !== daemon.projectPath
    ) {
      initializedAgentPanelProject.current = daemon.projectPath;
      if (!conversations.tabs.length) conversations.focus(agentBackend);
    }
  }, [
    showRightPanel,
    conversations.ready,
    conversations.tabs.length,
    conversations.focus,
    agentBackend,
    daemon.projectPath,
  ]);

  useEffect(() => {
    localStorage.setItem("lmms-writer-agent-backend", agentBackend);
  }, [agentBackend]);

  useEffect(() => {
    if (pendingGoToLine > 0) {
      // Give the editor time to load new file content before clearing
      const timer = setTimeout(() => setPendingGoToLine(0), 3000);
      return () => clearTimeout(timer);
    }
  }, [pendingGoToLine]);

  useEffect(() => {
    if (!daemon.projectPath) setSplitPane(null);
  }, [daemon.projectPath]);

  useEffect(() => {
    setShowTerminal(Boolean(daemon.projectPath));
  }, [daemon.projectPath]);

  useEffect(() => {
    const COMPACT_THRESHOLD = 1100;

    const handleResize = throttle(() => {
      if (window.innerWidth < COMPACT_THRESHOLD) {
        setShowRightPanel(false);
      }
    }, 100);

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const fileIndex = useMemo(() => buildFileIndex(daemon.files), [daemon.files]);
  const resolveSelectablePath = useCallback(
    (candidatePath: string) => {
      const normalized = projectRelativePath(daemon.projectPath ?? "", candidatePath);
      return resolveFileReference(normalized, fileIndex);
    },
    [daemon.projectPath, fileIndex],
  );

  const handleFileSelect = useCallback(
    async (path: string) => {
      const project = daemon.projectPath;
      if (!project) return;
      const requestId = ++primaryLoadRequestIdRef.current;
      if (!(await flushBeforeLeave()) || requestId !== primaryLoadRequestIdRef.current) return;
      let resolvedPath = path;
      try {
        resolvedPath = resolveSelectablePath(path);
        const local = await resolveLocalFile(project, resolvedPath);
        if (requestId !== primaryLoadRequestIdRef.current) return;
        if (local.directory || local.projectPath === null || fileKind(resolvedPath) === "binary") {
          await revealInFileManager(project, local.path);
          return;
        }
        resolvedPath = local.projectPath;
      } catch (cause) {
        toast(String(cause), "error");
        return;
      }
      setFileLoadError(null);
      setEditorViewMode("file");
      setGitDiffPreview(null);
      const fileType = fileKind(resolvedPath);

      setOpenTabs((prev) => {
        if (prev.includes(resolvedPath)) return prev;
        return [...prev, resolvedPath];
      });
      setSelectedFile(resolvedPath);
      setBinaryPreviewUrl(null);

      if (fileType === "text") {
        setIsLoadingFile(true);
        try {
          const content = await daemon.readFile(resolvedPath);
          if (requestId !== primaryLoadRequestIdRef.current) return;
          setFileContent(saveManager.open(project, resolvedPath, content ?? ""));
        } catch (err) {
          if (requestId !== primaryLoadRequestIdRef.current) return;
          const errorStr = String(err);
          setFileLoadError(errorStr);

          // Handle file not found - remove from tabs and notify user
          if (errorStr.includes("FILE_NOT_FOUND")) {
            const fileName = pathSync.basename(resolvedPath);
            toast(t("page.fileNameNoLongerExistsAndHasBeenRemovedF", { name: fileName }), "error");

            // Remove the file from open tabs
            setOpenTabs((prev) => {
              const newTabs = prev.filter((p) => p !== resolvedPath);

              // Switch to another tab if available
              if (newTabs.length > 0) {
                const nextFile = newTabs[0];
                if (nextFile) {
                  // Recursively try to open the next file
                  setTimeout(() => handleFileSelect(nextFile), 0);
                }
              } else {
                // No more tabs, clear selection
                setSelectedFile(undefined);
                setFileContent("");
              }

              return newTabs;
            });
          } else {
            if (errorStr.includes("BINARY_FILE")) {
              const fullPath = daemon.projectPath
                ? pathSync.join(daemon.projectPath, resolvedPath)
                : resolvedPath;
              setBinaryPreviewUrl(convertFileSrc(fullPath));
              setFileContent("");
              return;
            }
            console.error("Failed to read file:", err);
            toast(t("page.failedToReadFileError", { error: String(err) }), "error");
            setFileContent("");
          }
        } finally {
          if (requestId === primaryLoadRequestIdRef.current) setIsLoadingFile(false);
        }
      } else {
        const fullPath = daemon.projectPath
          ? pathSync.join(daemon.projectPath, resolvedPath)
          : resolvedPath;
        setBinaryPreviewUrl(convertFileSrc(fullPath));
        setFileContent("");
      }
    },
    [daemon, resolveSelectablePath, toast, saveManager, flushBeforeLeave, t],
  );

  const [pendingPdfPage, setPendingPdfPage] = useState<{ path: string; page: number } | null>(null);
  const handleChatFileClick = useCallback(
    async (reference: string) => {
      const target = parseChatLink(reference, daemon.projectPath ?? undefined);
      if (target.kind === "external-file") {
        try {
          await revealInFileManager(daemon.projectPath ?? "", target.path);
          toast(t("page.shownNameInTheFileManager", { name: pathSync.basename(target.path) }));
        } catch (cause) {
          toast(t("page.couldNotOpenTheFileSFolderError", { error: String(cause) }), "error");
        }
        return;
      }
      if (target.kind !== "file") {
        toast(t("page.thisLinkIsNotPartOfTheCurrentProject"), "error");
        return;
      }
      let filePath = target.path;
      try {
        const active = latexSettings.activeTarget;
        const expectedPdf = active
          ? `${active.outputDir === "." ? "" : `${active.outputDir}/`}${active.mainFile
              .split("/")
              .pop()
              ?.replace(/\.tex$/i, ".pdf")}`
          : null;
        filePath = resolveFileReference(
          filePath,
          fileIndex,
          [active?.mainFile, expectedPdf].filter((p): p is string => Boolean(p)),
        );
      } catch (cause) {
        toast(String(cause), "error");
        return;
      }
      await handleFileSelect(filePath);
      if (target.line) setPendingGoToLine(target.line);
      if (target.page) setPendingPdfPage({ path: filePath, page: target.page });
    },
    [daemon.projectPath, handleFileSelect, toast, fileIndex, latexSettings.activeTarget, t],
  );

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listenHere<{ href: string }>(
      "writer://open-link",
      ({ payload }) => void handleChatFileClick(payload.href),
    ).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [handleChatFileClick]);

  useEffect(() => {
    if (!pendingOpenCodeMessage || !conversations.ready) return;
    const tabId = conversations.focus(pendingBackend);
    conversations.dispatch({ backend: pendingBackend, tabId }, pendingOpenCodeMessage);
    setPendingOpenCodeMessage(null);
  }, [
    pendingOpenCodeMessage,
    pendingBackend,
    conversations.ready,
    conversations.focus,
    conversations.dispatch,
  ]);
  const handleAnnotationTask = useCallback(
    (ids: string[], target: ConversationTarget) => {
      conversations.dispatch(target, annotationPrompt(ids, target.backend));
      setAgentBackend(target.backend);
      setShowRightPanel(true);
    },
    [conversations.dispatch],
  );
  const handleAnnotationSource = useCallback(
    async (file: string, line: number) => {
      await handleFileSelect(file);
      setPendingGoToLine(line);
    },
    [handleFileSelect],
  );

  const handleSynctexClick = useCallback(
    async (page: number, x: number, y: number) => {
      if (!daemon.projectPath || !selectedFile) return;

      // Resolve the PDF path on disk
      const pdfPath = pathSync.join(daemon.projectPath, selectedFile);

      try {
        const result = await invoke<SynctexResult>("latex_synctex_edit", {
          pdfPath,
          page,
          x,
          y,
        });

        // Normalize slashes and resolve "." segments for comparison
        const normalize = (p: string) =>
          p
            .replace(/\\/g, "/")
            .replace(/\/\.\//g, "/")
            .replace(/\/+/g, "/");

        const normalFile = normalize(result.file);
        const normalProject = normalize(daemon.projectPath);

        let resolvedFile = normalFile;
        if (resolvedFile.startsWith(normalProject)) {
          resolvedFile = resolvedFile.slice(normalProject.length);
          // Remove leading slash
          resolvedFile = resolvedFile.replace(/^\/+/, "");
        }

        // Open the file and navigate to the line
        await handleFileSelect(resolvedFile);
        setPendingGoToLine(result.line);
      } catch (err) {
        const errorStr = String(err);
        if (errorStr.includes("SYNCTEX_NOT_INSTALLED")) {
          pendingSynctexRetryRef.current = { page, x, y, context: "main" };
          setShowSynctexInstallDialog(true);
        } else {
          const errorMessage = getSynctexLookupMessage(err);
          console.warn(`SyncTeX lookup failed: ${getReadableErrorMessage(err, errorMessage)}`);
          toast(errorMessage, "error");
        }
      }
    },
    [daemon.projectPath, selectedFile, handleFileSelect, toast],
  );

  const handleSplitSynctexClick = useCallback(
    async (page: number, x: number, y: number) => {
      if (!daemon.projectPath || !splitPane?.selectedFile) return;

      const pdfPath = pathSync.join(daemon.projectPath, splitPane.selectedFile);

      try {
        const result = await invoke<SynctexResult>("latex_synctex_edit", {
          pdfPath,
          page,
          x,
          y,
        });

        const normalize = (p: string) =>
          p
            .replace(/\\/g, "/")
            .replace(/\/\.\//g, "/")
            .replace(/\/+/g, "/");

        const normalFile = normalize(result.file);
        const normalProject = normalize(daemon.projectPath);

        let resolvedFile = normalFile;
        if (resolvedFile.startsWith(normalProject)) {
          resolvedFile = resolvedFile.slice(normalProject.length);
          resolvedFile = resolvedFile.replace(/^\/+/, "");
        }

        await handleFileSelect(resolvedFile);
        setPendingGoToLine(result.line);
      } catch (err) {
        const errorStr = String(err);
        if (errorStr.includes("SYNCTEX_NOT_INSTALLED")) {
          pendingSynctexRetryRef.current = { page, x, y, context: "split" };
          setShowSynctexInstallDialog(true);
        } else {
          const errorMessage = getSynctexLookupMessage(err);
          console.warn(`SyncTeX lookup failed: ${getReadableErrorMessage(err, errorMessage)}`);
          toast(errorMessage, "error");
        }
      }
    },
    [daemon.projectPath, splitPane, handleFileSelect, toast],
  );

  const handleSynctexInstallComplete = useCallback(() => {
    setShowSynctexInstallDialog(false);
    const pending = pendingSynctexRetryRef.current;
    if (pending) {
      pendingSynctexRetryRef.current = null;
      // Small delay to let PATH refresh after installation
      setTimeout(() => {
        if (pending.context === "main") {
          handleSynctexClick(pending.page, pending.x, pending.y);
        } else {
          handleSplitSynctexClick(pending.page, pending.x, pending.y);
        }
      }, 500);
    }
  }, [handleSynctexClick, handleSplitSynctexClick]);

  const loadGitDiffPreview = useCallback(
    async (path: string, staged: boolean) => {
      const requestId = gitDiffRequestIdRef.current + 1;
      gitDiffRequestIdRef.current = requestId;

      setGitDiffPreview({
        path,
        staged,
        content: "",
        isLoading: true,
        error: null,
      });

      try {
        const content = await daemon.gitDiff(path, staged);
        if (gitDiffRequestIdRef.current !== requestId) return;
        setGitDiffPreview({
          path,
          staged,
          content,
          isLoading: false,
          error: null,
        });
      } catch (error) {
        if (gitDiffRequestIdRef.current !== requestId) return;
        setGitDiffPreview({
          path,
          staged,
          content: "",
          isLoading: false,
          error: String(error),
        });
      }
    },
    [daemon],
  );

  const handlePreviewGitDiff = useCallback(
    async (path: string, staged: boolean) => {
      setOpenTabs((prev) => {
        if (prev.includes(path)) return prev;
        return [...prev, path];
      });
      setSelectedFile(path);
      setBinaryPreviewUrl(null);
      setEditorViewMode("git-diff");
      await loadGitDiffPreview(path, staged);
    },
    [loadGitDiffPreview],
  );

  useEffect(() => {
    if (selectedFile && !openTabs.includes(selectedFile)) {
      setOpenTabs((prev) => [...prev, selectedFile]);
    }
  }, [selectedFile, openTabs]);

  useEffect(() => {
    const event = daemon.lastFileChange,
      project = daemon.projectPath;
    if (!event || !project || fileKind(event.path) !== "text") return;
    const doc = saveManager.get(project, event.path);
    if (!doc) return;
    if (["modify", "create", "rename", "remove"].includes(event.kind))
      void saveManager.synchronizeDocument(doc).catch(() => {});
  }, [daemon.lastFileChange, daemon.projectPath, saveManager]);
  useEffect(() => {
    if (saving.revision < 0 || !daemon.projectPath) return;
    const doc = selectedFile ? saveManager.get(daemon.projectPath, selectedFile) : undefined;
    if (doc) setFileContent((current) => (current === doc.content ? current : doc.content));
    setSplitPane((current) => {
      if (!current?.selectedFile) return current;
      const split = saveManager.get(daemon.projectPath as string, current.selectedFile);
      return split && split.content !== current.content
        ? { ...current, content: split.content }
        : current;
    });
  }, [saving.revision, daemon.projectPath, selectedFile, saveManager]);

  const handleCloseTab = useCallback(
    async (path: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (!(await flushBeforeLeave())) return;
      setOpenTabs((prev) => {
        const newTabs = prev.filter((p) => p !== path);
        if (selectedFile === path) {
          const idx = prev.indexOf(path);
          const newSelected = newTabs[Math.min(idx, newTabs.length - 1)];
          if (newSelected) {
            handleFileSelect(newSelected);
          } else {
            setSelectedFile(undefined);
            setFileContent("");
            setBinaryPreviewUrl(null);
            setGitDiffPreview(null);
            setEditorViewMode("file");
          }
        }
        return newTabs;
      });
    },
    [selectedFile, handleFileSelect, flushBeforeLeave],
  );

  const handleCloseOtherTabs = useCallback(
    async (keepPath: string) => {
      if (!(await flushBeforeLeave())) return;
      setOpenTabs([keepPath]);
      if (selectedFile !== keepPath) {
        handleFileSelect(keepPath);
      }
    },
    [selectedFile, handleFileSelect, flushBeforeLeave],
  );

  const handleCloseTabsToLeft = useCallback(
    async (path: string) => {
      if (!(await flushBeforeLeave())) return;
      setOpenTabs((prev) => {
        const idx = prev.indexOf(path);
        if (idx <= 0) return prev;
        const newTabs = prev.slice(idx);
        if (selectedFile && !newTabs.includes(selectedFile)) {
          handleFileSelect(path);
        }
        return newTabs;
      });
    },
    [selectedFile, handleFileSelect, flushBeforeLeave],
  );

  const handleCloseTabsToRight = useCallback(
    async (path: string) => {
      if (!(await flushBeforeLeave())) return;
      setOpenTabs((prev) => {
        const idx = prev.indexOf(path);
        if (idx === prev.length - 1) return prev;
        const newTabs = prev.slice(0, idx + 1);
        if (selectedFile && !newTabs.includes(selectedFile)) {
          handleFileSelect(path);
        }
        return newTabs;
      });
    },
    [selectedFile, handleFileSelect, flushBeforeLeave],
  );

  const handleCloseAllTabs = useCallback(async () => {
    if (!(await flushBeforeLeave())) return;
    primaryLoadRequestIdRef.current++;
    setOpenTabs([]);
    setSelectedFile(undefined);
    setFileContent("");
    setGitDiffPreview(null);
    setEditorViewMode("file");
    splitLoadRequestIdRef.current++;
    setSplitPane(null);
  }, [flushBeforeLeave]);

  const handleReorderTabs = useCallback(
    (draggedPath: string, targetPath: string, position: TabReorderPosition) => {
      if (draggedPath === targetPath) return;

      setOpenTabs((prev) => {
        const fromIndex = prev.indexOf(draggedPath);
        const targetIndex = prev.indexOf(targetPath);
        if (fromIndex < 0 || targetIndex < 0) return prev;

        const reordered = [...prev];
        const [movedTab] = reordered.splice(fromIndex, 1);
        if (!movedTab) return prev;

        const targetAfterRemoval = reordered.indexOf(targetPath);
        if (targetAfterRemoval < 0) return prev;

        const insertIndex = position === "before" ? targetAfterRemoval : targetAfterRemoval + 1;
        reordered.splice(insertIndex, 0, movedTab);
        return reordered;
      });
    },
    [],
  );

  const closeSplitPane = useCallback(async () => {
    if (!(await flushBeforeLeave())) return;
    splitLoadRequestIdRef.current++;
    setSplitPane(null);
  }, [flushBeforeLeave]);

  const openFileInSplitPane = useCallback(
    async (path: string, side: SplitPaneSide, options?: { moveFromPrimary?: boolean }) => {
      const project = daemon.projectPath;
      if (!project || !(await flushBeforeLeave())) return;
      let resolvedPath: string;
      try {
        resolvedPath = resolveSelectablePath(path);
      } catch (cause) {
        toast(String(cause), "error");
        return;
      }
      const fileType = fileKind(resolvedPath);
      if (fileType === "binary") {
        try {
          await revealInFileManager(project, resolvedPath);
        } catch (cause) {
          toast(String(cause), "error");
        }
        return;
      }
      const requestId = splitLoadRequestIdRef.current + 1;
      splitLoadRequestIdRef.current = requestId;

      if (options?.moveFromPrimary) {
        setOpenTabs((prev) => {
          if (!prev.includes(resolvedPath)) return prev;

          const idx = prev.indexOf(resolvedPath);
          const newTabs = prev.filter((p) => p !== resolvedPath);
          if (selectedFile === resolvedPath) {
            const nextFile = newTabs[Math.min(idx, newTabs.length - 1)];
            if (nextFile) {
              void handleFileSelect(nextFile);
            } else {
              setSelectedFile(undefined);
              setFileContent("");
              setBinaryPreviewUrl(null);
              setGitDiffPreview(null);
              setEditorViewMode("file");
            }
          }
          return newTabs;
        });
      }

      if (fileType === "text") {
        setSplitPane((prev) => {
          const base: SplitPaneState = prev ?? {
            side,
            openTabs: [],
            selectedFile: undefined,
            content: "",
            isLoading: false,
            error: null,
            binaryPreviewUrl: null,
            pdfRefreshKey: 0,
          };
          return {
            ...base,
            side,
            openTabs: base.openTabs.includes(resolvedPath)
              ? base.openTabs
              : [...base.openTabs, resolvedPath],
            selectedFile: resolvedPath,
            content: "",
            isLoading: true,
            error: null,
            binaryPreviewUrl: null,
          };
        });

        try {
          const content = await daemon.readFile(resolvedPath);
          if (splitLoadRequestIdRef.current !== requestId) return;
          const loaded = saveManager.open(project, resolvedPath, content ?? "");
          setSplitPane((prev) => {
            if (!prev || prev.selectedFile !== resolvedPath) return prev;
            return {
              ...prev,
              side,
              content: loaded,
              isLoading: false,
              error: null,
              binaryPreviewUrl: null,
            };
          });
        } catch (err) {
          if (splitLoadRequestIdRef.current !== requestId) return;
          const errorStr = String(err);
          if (errorStr.includes("FILE_NOT_FOUND")) {
            toast(
              t("page.fileNameNoLongerExists", { name: pathSync.basename(resolvedPath) }),
              "error",
            );
            setSplitPane(null);
            return;
          }
          if (errorStr.includes("BINARY_FILE")) {
            const fullPath = daemon.projectPath
              ? pathSync.join(daemon.projectPath, resolvedPath)
              : resolvedPath;
            setSplitPane((prev) => {
              if (!prev || prev.selectedFile !== resolvedPath) return prev;
              return {
                ...prev,
                isLoading: false,
                error: null,
                binaryPreviewUrl: convertFileSrc(fullPath),
              };
            });
            return;
          }
          setSplitPane((prev) => {
            if (!prev || prev.selectedFile !== resolvedPath) return prev;
            return {
              ...prev,
              isLoading: false,
              error: errorStr,
            };
          });
        }
        return;
      }

      const fullPath = daemon.projectPath
        ? pathSync.join(daemon.projectPath, resolvedPath)
        : resolvedPath;
      setSplitPane((prev) => {
        const base: SplitPaneState = prev ?? {
          side,
          openTabs: [],
          selectedFile: undefined,
          content: "",
          isLoading: false,
          error: null,
          binaryPreviewUrl: null,
          pdfRefreshKey: 0,
        };
        return {
          ...base,
          side,
          openTabs: base.openTabs.includes(resolvedPath)
            ? base.openTabs
            : [...base.openTabs, resolvedPath],
          selectedFile: resolvedPath,
          content: "",
          isLoading: false,
          error: null,
          binaryPreviewUrl: convertFileSrc(fullPath),
          pdfRefreshKey: 0,
        };
      });
    },
    [
      daemon,
      resolveSelectablePath,
      toast,
      selectedFile,
      handleFileSelect,
      saveManager,
      flushBeforeLeave,
      t,
    ],
  );

  const handleSplitContentChange = useCallback(
    (content: string, previous?: string) => {
      if (!daemon.projectPath || !splitPane?.selectedFile || splitPane.isLoading || splitPane.error)
        return;
      saveManager.edit(daemon.projectPath, splitPane.selectedFile, content, previous);
      content = saveManager.get(daemon.projectPath, splitPane.selectedFile)?.content ?? content;
      setSplitPane((prev) => (prev ? { ...prev, content } : prev));
      if (selectedFile === splitPane.selectedFile) setFileContent(content);
    },
    [daemon.projectPath, splitPane, selectedFile, saveManager],
  );

  const handleSplitTabSelect = useCallback(
    (path: string) => {
      if (!splitPane) return;
      void openFileInSplitPane(path, splitPane.side);
    },
    [splitPane, openFileInSplitPane],
  );

  const handleSplitCloseTab = useCallback(
    async (path: string) => {
      if (!(await flushBeforeLeave())) return;
      if (!splitPane) return;

      const idx = splitPane.openTabs.indexOf(path);
      if (idx < 0) return;
      const newTabs = splitPane.openTabs.filter((p) => p !== path);
      if (newTabs.length === 0) {
        closeSplitPane();
        return;
      }

      const nextSelected =
        splitPane.selectedFile === path
          ? newTabs[Math.min(idx, newTabs.length - 1)]
          : (splitPane.selectedFile ?? newTabs[0]);

      setSplitPane((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          openTabs: newTabs,
          selectedFile: nextSelected,
        };
      });

      if (splitPane.selectedFile === path && nextSelected) {
        void openFileInSplitPane(nextSelected, splitPane.side);
      }
    },
    [splitPane, closeSplitPane, openFileInSplitPane, flushBeforeLeave],
  );

  const handleSplitCloseOtherTabs = useCallback(
    async (keepPath: string) => {
      if (!(await flushBeforeLeave())) return;
      if (!splitPane) return;
      setSplitPane((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          openTabs: [keepPath],
          selectedFile: keepPath,
        };
      });
      if (splitPane.selectedFile !== keepPath) {
        void openFileInSplitPane(keepPath, splitPane.side);
      }
    },
    [splitPane, openFileInSplitPane, flushBeforeLeave],
  );

  const handleSplitCloseTabsToLeft = useCallback(
    async (path: string) => {
      if (!(await flushBeforeLeave())) return;
      if (!splitPane) return;
      const idx = splitPane.openTabs.indexOf(path);
      if (idx <= 0) return;
      const newTabs = splitPane.openTabs.slice(idx);
      setSplitPane((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          openTabs: newTabs,
          selectedFile:
            prev.selectedFile && newTabs.includes(prev.selectedFile) ? prev.selectedFile : path,
        };
      });
      if (splitPane.selectedFile && !newTabs.includes(splitPane.selectedFile)) {
        void openFileInSplitPane(path, splitPane.side);
      }
    },
    [splitPane, openFileInSplitPane, flushBeforeLeave],
  );

  const handleSplitCloseTabsToRight = useCallback(
    async (path: string) => {
      if (!(await flushBeforeLeave())) return;
      if (!splitPane) return;
      const idx = splitPane.openTabs.indexOf(path);
      if (idx === splitPane.openTabs.length - 1) return;
      const newTabs = splitPane.openTabs.slice(0, idx + 1);
      setSplitPane((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          openTabs: newTabs,
          selectedFile:
            prev.selectedFile && newTabs.includes(prev.selectedFile) ? prev.selectedFile : path,
        };
      });
      if (splitPane.selectedFile && !newTabs.includes(splitPane.selectedFile)) {
        void openFileInSplitPane(path, splitPane.side);
      }
    },
    [splitPane, openFileInSplitPane, flushBeforeLeave],
  );

  const handleSplitReorderTabs = useCallback(
    (draggedPath: string, targetPath: string, position: TabReorderPosition) => {
      if (draggedPath === targetPath) return;
      setSplitPane((prev) => {
        if (!prev) return prev;
        const fromIndex = prev.openTabs.indexOf(draggedPath);
        const targetIndex = prev.openTabs.indexOf(targetPath);
        if (fromIndex < 0 || targetIndex < 0) return prev;

        const reordered = [...prev.openTabs];
        const [movedTab] = reordered.splice(fromIndex, 1);
        if (!movedTab) return prev;

        const targetAfterRemoval = reordered.indexOf(targetPath);
        if (targetAfterRemoval < 0) return prev;

        const insertIndex = position === "before" ? targetAfterRemoval : targetAfterRemoval + 1;
        reordered.splice(insertIndex, 0, movedTab);
        return {
          ...prev,
          openTabs: reordered,
        };
      });
    },
    [],
  );

  const resolveSplitDropSide = useCallback(
    (clientX: number, clientY: number, source: DragSourcePane): SplitPaneSide | null => {
      const container = editorWorkspaceRef.current;
      if (!container) return null;

      const rect = container.getBoundingClientRect();
      const isInsideEditorWorkspace =
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom;

      if (!isInsideEditorWorkspace) return null;

      const hoveredSide: SplitPaneSide = clientX < rect.left + rect.width / 2 ? "left" : "right";

      if (!splitPane) return source === "primary" ? hoveredSide : null;

      const splitSide: SplitPaneSide = splitPane.side;
      const primarySide: SplitPaneSide = splitSide === "left" ? "right" : "left";

      if (source === "primary") {
        return hoveredSide === splitSide ? splitSide : null;
      }

      return hoveredSide === primarySide ? primarySide : null;
    },
    [splitPane],
  );

  const handleEditorTabDragMove = useCallback(
    (payload: TabDragMovePayload | null) => {
      if (!payload) {
        setSplitDropHint(null);
        return;
      }

      setSplitDropHint(resolveSplitDropSide(payload.clientX, payload.clientY, "primary"));
    },
    [resolveSplitDropSide],
  );

  const moveTabFromSplitToPrimary = useCallback(
    (path: string) => {
      if (!splitPane) return;
      const resolvedPath = resolveSelectablePath(path);
      const currentIndex = splitPane.openTabs.indexOf(resolvedPath);
      if (currentIndex < 0) return;

      const nextTabs = splitPane.openTabs.filter((p) => p !== resolvedPath);
      if (nextTabs.length === 0) {
        closeSplitPane();
      } else {
        const nextSelected =
          splitPane.selectedFile === resolvedPath
            ? nextTabs[Math.min(currentIndex, nextTabs.length - 1)]
            : (splitPane.selectedFile ?? nextTabs[0]);

        setSplitPane((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            openTabs: nextTabs,
            selectedFile: nextSelected,
          };
        });

        if (splitPane.selectedFile === resolvedPath && nextSelected) {
          void openFileInSplitPane(nextSelected, splitPane.side);
        }
      }

      void handleFileSelect(resolvedPath);
    },
    [splitPane, resolveSelectablePath, closeSplitPane, openFileInSplitPane, handleFileSelect],
  );

  const handleSplitTabDragMove = useCallback(
    (payload: TabDragMovePayload | null) => {
      if (!payload) {
        setSplitDropHint(null);
        return;
      }

      setSplitDropHint(resolveSplitDropSide(payload.clientX, payload.clientY, "split"));
    },
    [resolveSplitDropSide],
  );

  const handleEditorTabDragEnd = useCallback(
    (payload: TabDragEndPayload) => {
      setSplitDropHint(null);
      if (payload.dropTarget.type !== "outside") return;

      const side = resolveSplitDropSide(payload.clientX, payload.clientY, "primary");
      if (!side) return;

      void openFileInSplitPane(payload.tabId, side, { moveFromPrimary: true });
    },
    [openFileInSplitPane, resolveSplitDropSide],
  );

  const handleSplitTabDragEnd = useCallback(
    (payload: TabDragEndPayload) => {
      setSplitDropHint(null);
      if (payload.dropTarget.type !== "outside") return;

      const side = resolveSplitDropSide(payload.clientX, payload.clientY, "split");
      if (!side || !splitPane) return;

      const primarySide: SplitPaneSide = splitPane.side === "left" ? "right" : "left";
      if (side !== primarySide) return;

      moveTabFromSplitToPrimary(payload.tabId);
    },
    [resolveSplitDropSide, splitPane, moveTabFromSplitToPrimary],
  );

  const splitPaneTabs = useMemo(
    (): TabItem[] =>
      splitPane?.openTabs.map((path) => ({
        id: path,
        label: pathSync.basename(path),
        title: path,
      })) ?? [],
    [splitPane?.openTabs],
  );

  const renderSplitPane = useCallback(
    (side: SplitPaneSide) => {
      if (!splitPane || splitPane.side !== side) return null;
      const splitSelectedFile = splitPane.selectedFile;
      const splitFileType = splitSelectedFile ? fileKind(splitSelectedFile) : "text";

      return (
        <div className="h-full min-h-0 flex flex-col overflow-hidden">
          {splitSelectedFile && (
            <div>
              <TabBar
                tabs={splitPaneTabs}
                activeTab={splitSelectedFile}
                onTabSelect={handleSplitTabSelect}
                onTabClose={handleSplitCloseTab}
                onTabReorder={handleSplitReorderTabs}
                onTabDragMove={handleSplitTabDragMove}
                onTabDragEnd={handleSplitTabDragEnd}
                onCloseOthers={handleSplitCloseOtherTabs}
                onCloseToLeft={handleSplitCloseTabsToLeft}
                onCloseToRight={handleSplitCloseTabsToRight}
                onCloseAll={closeSplitPane}
                variant="editor"
              />
            </div>
          )}

          <div className="flex-1 min-h-0">
            {!splitSelectedFile ? (
              <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                {t("page.dragATabHereToOpenASecondEditorGroup")}
              </div>
            ) : splitPane.isLoading ? (
              <EditorSkeleton className="h-full" />
            ) : splitPane.error ? (
              <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                {t("page.couldNotLoadTheFileError", { error: splitPane.error })}
              </div>
            ) : splitPane.binaryPreviewUrl ? (
              <div className="h-full flex items-center justify-center overflow-auto p-4 bg-accent-hover">
                {splitFileType === "image" ? (
                  <Image
                    unoptimized
                    src={splitPane.binaryPreviewUrl}
                    alt={splitSelectedFile}
                    width={1200}
                    height={900}
                    className="max-w-full max-h-full object-contain"
                  />
                ) : splitFileType === "pdf" ? (
                  <PdfViewer
                    src={splitPane.binaryPreviewUrl}
                    project={daemon.projectPath ?? undefined}
                    pdfPath={splitPane.selectedFile}
                    refreshKey={splitPane.pdfRefreshKey}
                    onSynctexClick={handleSplitSynctexClick}
                  />
                ) : splitFileType === "binary" ? (
                  <button
                    type="button"
                    className="border border-border px-3 py-2"
                    onClick={() =>
                      void revealInFileManager(daemon.projectPath ?? "", splitSelectedFile).catch(
                        (cause) => toast(String(cause), "error"),
                      )
                    }
                  >
                    {t("page.showInFileManager")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="border border-border px-3 py-2"
                    onClick={() =>
                      void revealInFileManager(daemon.projectPath ?? "", splitSelectedFile).catch(
                        (cause) => toast(String(cause), "error"),
                      )
                    }
                  >
                    {t("page.thisFileCannotBePreviewedShowInFileManag")}
                  </button>
                )}
              </div>
            ) : (
              <EditorErrorBoundary>
                <MonacoEditor
                  key={splitSelectedFile}
                  project={daemon.projectPath ?? undefined}
                  path={splitSelectedFile}
                  content={splitPane.content}
                  readOnly={isWriterManagedPath(splitSelectedFile)}
                  onContentChange={handleSplitContentChange}
                  onSelectionChange={(ranges) =>
                    handleEditorSelection(daemon.projectPath, splitSelectedFile, ranges)
                  }
                  language={fileLanguage(splitSelectedFile)}
                  editorSettings={editorSettings.settings}
                  editorTheme={editorSettings.editorTheme}
                  className="h-full"
                />
              </EditorErrorBoundary>
            )}
          </div>
        </div>
      );
    },
    [
      splitPane,
      daemon.projectPath,
      handleEditorSelection,
      closeSplitPane,
      splitPaneTabs,
      handleSplitTabSelect,
      handleSplitCloseTab,
      handleSplitReorderTabs,
      handleSplitTabDragMove,
      handleSplitTabDragEnd,
      handleSplitCloseOtherTabs,
      handleSplitCloseTabsToLeft,
      handleSplitCloseTabsToRight,
      handleSplitSynctexClick,
      handleSplitContentChange,
      editorSettings.settings,
      editorSettings.editorTheme,
      toast,
      t,
    ],
  );

  // Convert openTabs to TabItem format for TabBar
  const editorTabs = useMemo(
    (): TabItem[] =>
      openTabs.map((path) => ({
        id: path,
        label: pathSync.basename(path),
        title: path,
      })),
    [openTabs],
  );

  // Sidebar tabs configuration
  const sidebarTabs = useMemo(
    (): TabItem[] => [
      { id: "files", label: t("page.files") },
      {
        id: "git",
        label: t("page.git"),
        badge: gitStatus && gitStatus.changes.length > 0 ? gitStatus.changes.length : undefined,
      },
    ],
    [gitStatus, t],
  );

  const handleContentChange = useCallback(
    (content: string, previous?: string) => {
      if (!daemon.projectPath || !selectedFile || isLoadingFile || fileLoadError) return;
      saveManager.edit(daemon.projectPath, selectedFile, content, previous);
      content = saveManager.get(daemon.projectPath, selectedFile)?.content ?? content;
      setFileContent(content);
      setSplitPane((prev) => (prev?.selectedFile === selectedFile ? { ...prev, content } : prev));
    },
    [daemon.projectPath, selectedFile, isLoadingFile, fileLoadError, saveManager],
  );

  const changeProject = useCallback(
    async (choose: () => Promise<string | null>) => {
      if (projectTransition.active) return;
      setChoosingProject(true);
      try {
        const path = await projectTransition.run({
          current: daemon.projectPath,
          // A project is open in one window at a time; bring that window forward instead.
          choose: async () => {
            const path = await choose();
            if (
              path &&
              path !== daemon.projectPath &&
              (await invoke<boolean>("focus_project_window", { path }))
            ) {
              toast(t("page.projectOpenInAnotherWindow"), "info");
              return null;
            }
            return path;
          },
          confirm: async () => {
            if (targetBuild.isBuilding() || latexSettings.saving)
              throw new Error(t("page.aBuildOrSettingsSaveIsStillRunningSwitch"));
            return confirmAgentsIdle("switch");
          },
          freeze: setSwitchingProject,
          save: async () => {
            // Commit the input method's current composition before reading editor buffers.
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            await saveManager.flushAll();
            if (daemon.projectPath) await flushComposerDrafts(daemon.projectPath);
          },
          open: daemon.setProject,
          reset: () => {
            primaryLoadRequestIdRef.current++;
            splitLoadRequestIdRef.current++;
            gitDiffRequestIdRef.current++;
            setOpenTabs([]);
            setSelectedFile(undefined);
            setFileContent("");
            setSplitPane(null);
            setEditorSelection(null);
            setBinaryPreviewUrl(null);
            setFileLoadError(null);
            setIsLoadingFile(false);
            setEditorViewMode("file");
            setGitDiffPreview(null);
            setPendingGoToLine(0);
            setShowSidebar(true);
            setShowRightPanel(true);
          },
        });
        if (path)
          await recentProjects
            .addProject(path)
            .catch((error) =>
              toast(
                t("page.theFolderIsOpenButTheRecentProjectsListW", { error: String(error) }),
                "error",
              ),
            );
      } catch (err) {
        console.error("Failed to open project:", err);
        toast(t("page.switchingFoldersWasCancelledTheCurrentPr", { error: String(err) }), "error");
      } finally {
        setChoosingProject(false);
      }
    },
    [
      daemon,
      recentProjects,
      toast,
      saveManager,
      confirmAgentsIdle,
      projectTransition,
      latexSettings.saving,
      targetBuild.isBuilding,
      t,
    ],
  );
  const handleOpenFolder = useCallback(
    () =>
      changeProject(async () => {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          directory: true,
          multiple: false,
          title: t("page.openFolder"),
          defaultPath: daemon.projectPath ? pathSync.dirname(daemon.projectPath) : undefined,
        });
        return typeof selected === "string" ? selected : null;
      }),
    [changeProject, daemon.projectPath, t],
  );
  const openWindow = useCallback(() => {
    void invoke("open_window").catch((error) =>
      toast(t("page.couldNotOpenAWindowError", { error: String(error) }), "error"),
    );
  }, [toast, t]);
  const handleOpenRecentProject = useCallback(
    (path: string) => changeProject(async () => path),
    [changeProject],
  );
  // "Open in desktop" on the web page: lmms-writer://open?server=…&project=…
  useEffect(() => {
    let stop: (() => void) | undefined,
      disposed = false;
    const handle = (urls: string[]) => {
      for (const raw of urls) {
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          continue;
        }
        const server = url.searchParams.get("server"),
          project = url.searchParams.get("project");
        if (url.protocol !== "lmms-writer:" || url.hostname !== "open" || !server || !project)
          continue;
        const known = linkedFolders().find((f) => f.server === server && f.project === project);
        if (known) void handleOpenRecentProject(known.path);
        else setOpenFromServer({ server, project });
      }
    };
    void import("@tauri-apps/plugin-deep-link")
      .then(async ({ getCurrent, onOpenUrl }) => {
        // The link that launched Writer belongs to its first window (or one opened for a link).
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const launchWindow =
          getCurrentWindow().label === "main" ||
          (window as { __WRITER_OPEN_LINK__?: boolean }).__WRITER_OPEN_LINK__ === true;
        const initial = launchWindow ? await getCurrent() : null;
        if (initial && !disposed) handle(initial);
        // Every window hears later links; the one in front opens them.
        const unlisten = await onOpenUrl(async (urls) => {
          if (await invoke<boolean>("window_is_primary")) handle(urls);
        });
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [handleOpenRecentProject]);

  const validateFileName = useCallback(
    (name: string): string | null => {
      if (!name.trim()) {
        return t("page.nameCannotBeEmpty");
      }
      if (name.includes("/") || name.includes("\\")) {
        return t("page.nameCannotContainOr");
      }
      if (name.startsWith(".")) {
        return t("page.nameCannotStartWith");
      }
      return null;
    },
    [t],
  );

  const handleCreateConfirm = useCallback(
    async (value: string) => {
      if (!createDialog) return;
      try {
        if (createDialog.type === "file") {
          await daemon.createFile(value);
        } else {
          await daemon.createDirectory(value);
        }
        setCreateDialog(null);
      } catch (error) {
        toast(t("page.failedToCreateError", { error: String(error) }), "error");
      }
    },
    [createDialog, daemon, toast, t],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (projectTransition.active) {
        if (isMod && ["o", "s", "w", "b"].includes(key)) e.preventDefault();
        return;
      }

      if (isMod && key === "s") {
        e.preventDefault();
        e.stopPropagation();
        void flushBeforeLeave();
        return;
      }

      if (isMod && key === "o" && !e.shiftKey) {
        e.preventDefault();
        handleOpenFolder();
        return;
      }

      // macOS opens windows from the File menu (⌘⇧N); elsewhere there is no menu bar.
      if (isMod && e.shiftKey && key === "n" && !/Mac/i.test(navigator.platform)) {
        e.preventDefault();
        openWindow();
        return;
      }

      if (isMod && key === "w" && !e.shiftKey) {
        e.preventDefault();
        if (selectedFile) {
          handleCloseTab(selectedFile);
        }
        return;
      }

      // Compile with AI: Cmd/Ctrl+Shift+B
      if (isMod && e.shiftKey && key === "b") {
        e.preventDefault();
        if (daemon.projectPath) {
          handleCompileWithDetection();
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    daemon,
    handleOpenFolder,
    selectedFile,
    handleCloseTab,
    handleCompileWithDetection,
    flushBeforeLeave,
    projectTransition,
    openWindow,
  ]);

  const isShowingGitDiff =
    editorViewMode === "git-diff" && !!gitDiffPreview && selectedFile === gitDiffPreview.path;

  const gitDiffContent = gitDiffPreview?.content;
  const parsedGitDiff = useMemo(() => {
    if (!gitDiffContent) return null;
    return parseUnifiedDiffContent(gitDiffContent);
  }, [gitDiffContent]);

  const primaryEditorPaneContent = (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      {selectedFile && (
        <TabBar
          tabs={editorTabs}
          activeTab={selectedFile}
          onTabSelect={handleFileSelect}
          onTabClose={handleCloseTab}
          onTabReorder={handleReorderTabs}
          onTabDragMove={handleEditorTabDragMove}
          onTabDragEnd={handleEditorTabDragEnd}
          onCloseOthers={handleCloseOtherTabs}
          onCloseToLeft={handleCloseTabsToLeft}
          onCloseToRight={handleCloseTabsToRight}
          onCloseAll={handleCloseAllTabs}
          variant="editor"
        />
      )}

      {selectedFile ? (
        isShowingGitDiff ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="border-b border-border bg-accent-hover px-3 py-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{gitDiffPreview.path}</div>
                <div className="text-xs text-muted flex items-center gap-2">
                  <span>
                    {gitDiffPreview.staged ? t("page.stagedChanges") : t("page.workingTreeChanges")}
                  </span>
                  {parsedGitDiff?.hasRenderableHunks && (
                    <span>
                      +{parsedGitDiff.added} / -{parsedGitDiff.removed}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void loadGitDiffPreview(gitDiffPreview.path, gitDiffPreview.staged)
                  }
                  className="btn btn-sm btn-secondary"
                >
                  {t("page.refreshDiff")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleFileSelect(gitDiffPreview.path);
                  }}
                  className="btn btn-sm btn-secondary"
                >
                  {t("page.openFile")}
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0">
              {gitDiffPreview.isLoading ? (
                <EditorSkeleton className="h-full" />
              ) : gitDiffPreview.error ? (
                <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                  {t("page.couldNotLoadTheDiffError", { error: gitDiffPreview.error })}
                </div>
              ) : parsedGitDiff?.isBinary ? (
                <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                  {t("page.binaryFileDiffIsNotPreviewableInEditor")}
                </div>
              ) : !gitDiffPreview.content.trim() ? (
                <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                  {t("page.noTextualDiffAvailableForThisFile")}
                </div>
              ) : parsedGitDiff?.hasRenderableHunks ? (
                <GitMonacoDiffEditor
                  original={parsedGitDiff.original}
                  modified={parsedGitDiff.modified}
                  filePath={gitDiffPreview.path}
                  editorSettings={editorSettings.settings}
                  className="h-full"
                />
              ) : (
                <MonacoEditor
                  content={gitDiffPreview.content}
                  readOnly
                  onContentChange={() => {}}
                  language="diff"
                  editorSettings={editorSettings.settings}
                  editorTheme={editorSettings.editorTheme}
                  className="h-full"
                />
              )}
            </div>
          </div>
        ) : binaryPreviewUrl ? (
          <div className="flex-1 flex flex-col bg-accent-hover overflow-hidden">
            {fileKind(selectedFile) === "image" ? (
              <div className="flex-1 flex items-center justify-center overflow-auto p-4">
                <Image
                  unoptimized
                  src={binaryPreviewUrl}
                  alt={selectedFile}
                  width={1200}
                  height={900}
                  className="max-w-full max-h-full object-contain"
                />
              </div>
            ) : fileKind(selectedFile) === "pdf" ? (
              <PdfViewer
                src={binaryPreviewUrl}
                project={daemon.projectPath ?? undefined}
                pdfPath={selectedFile}
                goToPage={pendingPdfPage?.path === selectedFile ? pendingPdfPage.page : undefined}
                refreshKey={pdfRefreshKey}
                onSynctexClick={handleSynctexClick}
              />
            ) : fileKind(selectedFile) === "binary" ? (
              <div className="flex-1 flex items-center justify-center overflow-auto p-4">
                <button
                  type="button"
                  className="border border-border px-3 py-2"
                  onClick={() =>
                    void revealInFileManager(daemon.projectPath ?? "", selectedFile).catch(
                      (cause) => toast(String(cause), "error"),
                    )
                  }
                >
                  {t("page.showInFileManager")}
                </button>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center overflow-auto p-4">
                <div className="flex flex-col items-center gap-3 text-sm text-muted">
                  <p>{t("page.thisFileCannotBePreviewedInTheEditor")}</p>
                  <button
                    type="button"
                    className="border border-border px-3 py-2"
                    onClick={() =>
                      void revealInFileManager(daemon.projectPath ?? "", selectedFile).catch(
                        (cause) => toast(String(cause), "error"),
                      )
                    }
                  >
                    {t("page.showInFileManager")}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : fileLoadError ? (
          <div role="alert" className="p-4 text-accent">
            {t("page.couldNotReadTheFileEditingIsPausedError", { error: fileLoadError })}
          </div>
        ) : isLoadingFile ? (
          <EditorSkeleton className="flex-1 min-h-0" />
        ) : (
          <div key={selectedFile} className="flex-1 min-h-0">
            <EditorErrorBoundary>
              <MonacoEditor
                project={daemon.projectPath ?? undefined}
                path={selectedFile}
                content={fileContent}
                readOnly={isWriterManagedPath(selectedFile)}
                onContentChange={handleContentChange}
                onSelectionChange={(ranges) =>
                  handleEditorSelection(daemon.projectPath, selectedFile, ranges)
                }
                language={fileLanguage(selectedFile)}
                editorSettings={editorSettings.settings}
                editorTheme={editorSettings.editorTheme}
                goToLine={pendingGoToLine}
                className="h-full"
              />
            </EditorErrorBoundary>
          </div>
        )
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center px-6 text-sm text-muted bg-accent-hover">
          {t("page.dropATabHereToOpenThisPanel")}
        </div>
      )}
    </div>
  );

  const editorPanelItems: DockviewPanelItem[] = [];
  if (selectedFile || openTabs.length > 0) {
    editorPanelItems.push({
      id: "editor-primary",
      title: selectedFile ? pathSync.basename(selectedFile) : "Editor",
      content: primaryEditorPaneContent,
      inactive: false,
    });
  }
  if (splitPane) {
    editorPanelItems.push({
      id: `editor-split-${splitPane.side}`,
      title: splitPane.selectedFile ? pathSync.basename(splitPane.selectedFile) : "Split",
      content: renderSplitPane(splitPane.side),
      inactive: false,
      position: {
        referencePanel: "editor-primary",
        direction: splitPane.side,
      },
    });
  }

  return (
    <AnnotationProvider
      project={daemon.projectPath ?? undefined}
      manager={saveManager}
      onTask={handleAnnotationTask}
      conversations={conversations.tabs}
      onSource={handleAnnotationSource}
      onPdf={handleFileSelect}
    >
      <TeamCommentsProvider projectPath={daemon.projectPath}>
        {switchingProject && (
          <div
            role="status"
            aria-live="polite"
            className="fixed inset-0 z-[250] flex items-center justify-center bg-background/70"
          >
            <p className="border border-border bg-background px-5 py-3 text-sm shadow-md">
              {t("page.savingAndOpeningTheFolder")}
            </p>
          </div>
        )}
        <div className="h-dvh flex flex-col" inert={switchingProject}>
          <div className="flex-shrink-0 flex flex-col">
            <header className="h-12 border-b border-border flex items-center">
              <div className="w-full px-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex items-center">
                    <Image
                      src="/logo-small-light.svg"
                      alt="Y-Writer"
                      width={140}
                      height={28}
                      className="h-7 w-auto dark:hidden"
                    />
                    <Image
                      src="/logo-small-dark.svg"
                      alt="Y-Writer"
                      width={140}
                      height={28}
                      className="h-7 w-auto hidden dark:block"
                    />
                  </div>
                  <span className="text-border">/</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="text-sm font-medium px-2 py-1 -ml-2 truncate">
                      {daemon.projectPath ? pathSync.basename(daemon.projectPath) : "Y-Writer"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleOpenFolder()}
                    disabled={choosingProject || daemon.isOpeningProject}
                    aria-label={t("page.openFolder")}
                    title={t("page.openFolderCtrlOCurrentChangesAreSavedFir")}
                    className="flex h-8 shrink-0 items-center gap-1.5 border border-border px-2 text-xs hover:bg-accent-hover disabled:opacity-50"
                  >
                    <FolderOpenIcon className="size-4" aria-hidden="true" />
                    <span className="hidden sm:inline">
                      {choosingProject ? t("page.opening") : t("page.openFolder")}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={openWindow}
                    aria-label={t("page.newWindow")}
                    title={t("page.newWindowShortcut")}
                    className="flex h-8 w-8 shrink-0 items-center justify-center border border-border hover:bg-accent-hover"
                  >
                    <AppWindowIcon className="size-4" aria-hidden="true" />
                  </button>
                </div>

                <div className="flex items-center gap-3 h-8">
                  {daemon.projectPath && (
                    <button
                      type="button"
                      onClick={() => setShowSidebar((prev) => !prev)}
                      className={`h-8 w-8 border border-border transition-colors flex items-center justify-center bg-background text-foreground ${
                        showSidebar
                          ? "border-foreground"
                          : "hover:bg-accent-hover hover:border-border-dark"
                      }`}
                      title={t("page.toggleSidebar")}
                    >
                      <SidebarSimpleIcon className="size-4" weight="bold" />
                    </button>
                  )}

                  {daemon.projectPath && (
                    <button
                      type="button"
                      onClick={() => setShowTerminal((prev) => !prev)}
                      className={`h-8 w-8 border border-border transition-colors flex items-center justify-center bg-background text-foreground ${
                        showTerminal
                          ? "border-foreground"
                          : "hover:bg-accent-hover hover:border-border-dark"
                      }`}
                      title={t("page.toggleTerminal")}
                    >
                      <TerminalIcon className="size-4" weight="bold" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleToggleRightPanel}
                    className={`h-8 w-8 border border-border transition-colors flex items-center justify-center bg-background text-foreground ${
                      showRightPanel
                        ? "border-foreground"
                        : "hover:bg-accent-hover hover:border-border-dark"
                    }`}
                    title={t("page.toggleAgentMode")}
                  >
                    <RobotIcon className="size-4" weight="bold" />
                  </button>

                  {daemon.projectPath && (
                    <>
                      <span className="text-border text-lg select-none">/</span>
                      <div className="flex items-center gap-2 h-8">
                        <select
                          aria-label={t("page.buildTarget")}
                          value={latexSettings.settings.config.activeTarget ?? ""}
                          disabled={
                            targetBuild.compiling ||
                            latexSettings.isDetecting ||
                            latexSettings.saving
                          }
                          onChange={(event) =>
                            void latexSettings.selectTarget(event.target.value).catch(() => {})
                          }
                          className="h-8 max-w-40 truncate border border-border bg-background px-2 text-xs"
                        >
                          {!latexSettings.settings.config.targets.length && (
                            <option value="">{t("page.addBuildTarget")}</option>
                          )}
                          {latexSettings.settings.config.targets.map((target) => (
                            <option key={target.id} value={target.id}>
                              {target.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => setShowTemplateImport(true)}
                          className="h-8 border border-border px-2 text-xs"
                          title={t("page.createANewProjectFromAZipOrFolder")}
                        >
                          {t("page.importTemplate")}
                        </button>

                        <button
                          type="button"
                          onClick={handleCompileWithDetection}
                          disabled={
                            targetBuild.compiling ||
                            latexSettings.isDetecting ||
                            latexSettings.saving
                          }
                          className={`h-8 w-8 border border-border transition-colors flex items-center justify-center bg-background text-foreground ${
                            latexSettings.isDetecting
                              ? "opacity-50 cursor-not-allowed"
                              : "hover:bg-accent-hover hover:border-border-dark"
                          }`}
                          title={
                            targetBuild.compiling
                              ? t("page.compiling")
                              : t("page.compileTheSelectedTargetCtrlShiftB")
                          }
                        >
                          <PlayCircleIcon className="size-4" />
                        </button>
                        {targetBuild.compiling && (
                          <button
                            type="button"
                            onClick={() =>
                              void invoke("latex_stop_compilation").catch((cause) =>
                                toast(String(cause), "error"),
                              )
                            }
                            className="h-8 border border-border px-2 text-xs"
                          >
                            {t("page.stopBuild")}
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => openSettings()}
                          className="h-8 w-8 border border-border bg-background text-foreground hover:bg-accent-hover hover:border-border-dark transition-colors flex items-center justify-center"
                          title={t("page.settings")}
                          aria-label={t("page.settings")}
                        >
                          <GearIcon className="size-4" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </header>
          </div>

          {daemon.projectPath && (
            <SaveStatus
              collaboration={
                daemon.projectPath ? (
                  <SyncPanel
                    sync={folderSync}
                    runner={sharedRunner}
                    projectPath={daemon.projectPath}
                    onOpenFromServer={() => setOpenFromServer(null)}
                    onOpenSettings={() => openSettings("collab")}
                  />
                ) : null
              }
              onOpenFile={handleChatFileClick}
              onConflictResolved={(conflict) => {
                if (!conflict.owner.startsWith("agent:")) return;
                const native = conflict.owner.slice(6),
                  separator = native.indexOf(":");
                const backend = native.slice(0, separator),
                  sessionId = native.slice(separator + 1);
                if (!isHarnessId(backend)) return;
                const tab = conversations.tabs.find(
                  (t) => t.backend === backend && t.sessionId === sessionId,
                );
                if (tab)
                  conversations.dispatch(
                    { backend, tabId: tab.id },
                    t("page.theUserResolvedAndSavedMergeConflictIdRe", {
                      id: conflict.id,
                      path: conflict.path,
                      comment: conflict.annotationId
                        ? t("page.andCommentId", { id: conflict.annotationId })
                        : "",
                    }),
                  );
              }}
              agentBusy={conversations.tabs.some(
                (t) => t.status === "running" || t.status === "waiting",
              )}
              rightActions={
                <HarnessButtons
                  workspace={conversations}
                  onChoose={(backend) => {
                    conversations.focus(backend);
                    setAgentBackend(backend);
                    setShowRightPanel(true);
                  }}
                />
              }
              manager={saveManager}
              project={daemon.projectPath}
              path={selectedFile}
              closeError={saving.closeError}
              clearCloseError={saving.clearCloseError}
              onOpenDraft={(path, content) => {
                primaryLoadRequestIdRef.current++;
                setSelectedFile(path);
                setFileContent(content);
                setFileLoadError(null);
                setIsLoadingFile(false);
                setBinaryPreviewUrl(null);
                setEditorViewMode("file");
              }}
              highlightAmbiguousUnicode={editorSettings.settings.highlightAmbiguousUnicode}
              onToggleUnicodeHighlight={() =>
                editorSettings.updateSettings({
                  highlightAmbiguousUnicode: !editorSettings.settings.highlightAmbiguousUnicode,
                })
              }
              onReload={(path, content) => {
                if (path === selectedFile) {
                  setFileContent(content);
                  setFileLoadError(null);
                }
                setSplitPane((prev) =>
                  prev?.selectedFile === path ? { ...prev, content, error: null } : prev,
                );
              }}
            />
          )}
          {latexSettings.error && (
            <p role="alert" className="border-b border-border px-3 py-2 text-xs text-red-600">
              {t("page.buildSettingsError", { error: latexSettings.error })}
            </p>
          )}
          <main className="flex-1 min-h-0 flex relative overflow-hidden">
            <AnimatePresence mode="wait">
              {showSidebar && (
                <div key="sidebar-container" className="flex flex-shrink-0">
                  <aside
                    style={{
                      width: resizing === "sidebar" ? "var(--sidebar-width)" : sidebarWidth,
                      willChange: resizing === "sidebar" ? "width" : undefined,
                    }}
                    className="border-r border-border flex flex-col flex-shrink-0 overflow-hidden"
                  >
                    <TabBar
                      tabs={sidebarTabs}
                      activeTab={sidebarTab}
                      onTabSelect={(id) => setSidebarTab(id as "files" | "git")}
                      variant="sidebar"
                    />

                    {sidebarTab === "files" && (
                      <FileSidebarPanel
                        projectPath={daemon.projectPath}
                        files={daemon.files}
                        selectedFile={selectedFile}
                        highlightedFile={highlightedFile}
                        onFileSelect={handleFileSelect}
                        onCreateFile={() => setCreateDialog({ type: "file" })}
                        onCreateDirectory={() => setCreateDialog({ type: "directory" })}
                        onRefreshFiles={daemon.refreshFiles}
                        outlinePath={
                          selectedFile?.endsWith(".tex")
                            ? selectedFile
                            : latexSettings.activeTarget?.mainFile
                        }
                        outlineSource={selectedFile?.endsWith(".tex") ? fileContent : undefined}
                        readSource={daemon.readFile}
                        onOutlineNavigate={async (path, line) => {
                          await handleFileSelect(path);
                          setPendingGoToLine(line);
                        }}
                        fileOperations={{
                          createFile: daemon.createFile,
                          createDirectory: daemon.createDirectory,
                          renamePath: daemon.renamePath,
                          deletePath: daemon.deletePath,
                        }}
                      />
                    )}

                    {sidebarTab === "git" && (
                      <div className="flex-1 flex flex-col overflow-hidden">
                        <GitSidebarPanel
                          projectPath={daemon.projectPath}
                          gitStatus={gitStatus}
                          gitGraph={daemon.gitGraph}
                          gitLogEntries={daemon.gitLogEntries}
                          {...git.panel}
                          onInitGit={daemon.gitInit}
                          isInitializingGit={daemon.isInitializingGit}
                          onPreviewDiff={handlePreviewGitDiff}
                          onOpenFile={(path) => {
                            void handleFileSelect(path);
                          }}
                          isPushing={daemon.isPushing}
                          isPulling={daemon.isPulling}
                          isAuthenticatingGh={daemon.isAuthenticatingGh}
                        />
                      </div>
                    )}
                  </aside>
                  <div className="relative group w-1 flex-shrink-0">
                    <motion.div
                      drag="x"
                      dragConstraints={{ left: 0, right: 0 }}
                      dragElastic={0}
                      dragMomentum={false}
                      onDragStart={() => startResize("sidebar")}
                      onDrag={(_event, info) => handleResizeDrag("sidebar", info)}
                      onDragEnd={endResize}
                      className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize z-10"
                      style={{ x: 0 }}
                    />
                    <div
                      className={`w-full h-full transition-colors ${resizing === "sidebar" ? "bg-foreground/20" : "group-hover:bg-foreground/20"}`}
                    />
                  </div>
                </div>
              )}
            </AnimatePresence>

            <div className="flex-1 min-w-0 w-0 flex flex-col overflow-hidden">
              {daemon.projectPath && editorPanelItems.length > 0 ? (
                <div ref={editorWorkspaceRef} className="relative flex-1 min-h-0">
                  {splitDropHint && (
                    <div className="pointer-events-none absolute inset-0 z-10">
                      <div
                        className={`absolute inset-y-0 w-1/2 transition-opacity duration-100 ${
                          splitDropHint === "left"
                            ? "left-0 border-r border-accent/40 bg-gradient-to-r from-foreground/15 to-transparent shadow-[inset_-20px_0_24px_-20px_rgba(0,0,0,0.45)]"
                            : "right-0 border-l border-accent/40 bg-gradient-to-l from-foreground/15 to-transparent shadow-[inset_20px_0_24px_-20px_rgba(0,0,0,0.45)]"
                        }`}
                      />
                    </div>
                  )}

                  <DockviewPanelLayout
                    panels={editorPanelItems}
                    className="dockview-editor-layout"
                  />
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  {daemon.projectPath ? (
                    <div />
                  ) : (
                    <div className="flex flex-col items-center justify-center text-center px-6">
                      <Image
                        src="/logo-light.svg"
                        alt="Y-Writer"
                        width={320}
                        height={96}
                        className="h-24 w-auto mb-10 dark:hidden"
                      />
                      <Image
                        src="/logo-dark.svg"
                        alt="Y-Writer"
                        width={320}
                        height={96}
                        className="h-24 w-auto mb-10 hidden dark:block"
                      />
                      <button type="button" onClick={handleOpenFolder} className="btn btn-primary">
                        {t("page.openFolder")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowTemplateImport(true)}
                        className="mt-3 border border-border px-4 py-2 text-sm"
                      >
                        {t("page.importALatexTemplateZipFolder")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setOpenFromServer(null)}
                        className="mt-3 border border-border px-4 py-2 text-sm"
                      >
                        {t("collab.open.button")}
                      </button>
                      <RecentProjects
                        projects={recentProjects.projects}
                        onSelect={handleOpenRecentProject}
                        onRemove={recentProjects.removeProject}
                        onClearAll={recentProjects.clearAll}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* LaTeX Install Prompt - shown when no compiler is detected */}
              {daemon.projectPath &&
                latexCompiler.compilersStatus &&
                !hasAnyCompiler &&
                !latexCompiler.isDetecting && (
                  <div className="border-t border-border">
                    <LaTeXInstallPrompt onRefreshCompilers={latexCompiler.detectCompilers} />
                  </div>
                )}

              <TerminalPanel
                projectPath={daemon.projectPath}
                open={showTerminal}
                shellMode={editorSettings.settings.terminalShellMode}
                customShell={editorSettings.settings.terminalShellPath}
                fontFamily={editorSettings.settings.terminalFontFamily}
                fontSize={editorSettings.settings.terminalFontSize}
                lineHeight={editorSettings.settings.terminalLineHeight}
                prefersReducedMotion={Boolean(prefersReducedMotion)}
                onClose={() => setShowTerminal(false)}
              />
            </div>

            <AnimatePresence>
              {(conversations.tabs.length > 0 || showRightPanel) && (
                <div
                  key="right-panel-container"
                  inert={!showRightPanel}
                  aria-hidden={!showRightPanel}
                  className="flex flex-shrink-0 bg-background overflow-hidden"
                  style={{
                    width: !showRightPanel
                      ? 0
                      : resizing === "right"
                        ? `calc(var(--right-panel-width) + 4px)`
                        : rightPanelWidth + 4,
                  }}
                >
                  <div className="relative group w-1 flex-shrink-0">
                    <motion.div
                      drag="x"
                      dragConstraints={{ left: 0, right: 0 }}
                      dragElastic={0}
                      dragMomentum={false}
                      onDragStart={() => startResize("right")}
                      onDrag={(_event, info) => handleResizeDrag("right", info)}
                      onDragEnd={endResize}
                      className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize z-10"
                      style={{ x: 0 }}
                    />
                    <div
                      className={`w-full h-full transition-colors ${resizing === "right" ? "bg-foreground/20" : "group-hover:bg-foreground/20"}`}
                    />
                  </div>
                  <aside
                    style={{
                      width: resizing === "right" ? "var(--right-panel-width)" : rightPanelWidth,
                      willChange: resizing === "right" ? "width" : undefined,
                    }}
                    className="border-l border-border flex flex-col flex-shrink-0 overflow-hidden"
                  >
                    <ChatImageDirectory.Provider value={daemon.projectPath ?? undefined}>
                      <HarnessWorkspace
                        workspace={conversations}
                        preferredBackend={agentBackend}
                        visible={showRightPanel}
                        onBackendChange={setAgentBackend}
                        shared={{
                          directory: daemon.projectPath ?? undefined,
                          onFileClick: handleChatFileClick,
                          editorSelection:
                            editorSelection?.project === daemon.projectPath
                              ? editorSelection
                              : null,
                          onClearSelection: () => setEditorSelection(null),
                          onSelectionSent: (sent) =>
                            setEditorSelection((current) =>
                              sameEditorSelection(current, sent) ? null : current,
                            ),
                          onBeforeSend: prepareEditorMessage,
                        }}
                        opencode={{
                          baseUrl: `http://localhost:${opencode.port}`,
                          autoConnect: opencode.status === "running" && !!daemon.projectPath,
                          daemonStatus: opencode.status,
                          onRestartOpenCode: opencode.restart,
                          onMaxReconnectFailed: opencode.showDisconnected,
                        }}
                      />
                    </ChatImageDirectory.Provider>
                  </aside>
                </div>
              )}
            </AnimatePresence>
          </main>

          <OpenCodeDisconnectedDialog
            open={opencode.disconnected}
            onClose={opencode.closeDisconnected}
            onRestart={opencode.restartFromDisconnected}
          />

          <OpenCodeErrorDialog
            open={!!opencode.error}
            error={opencode.error ?? ""}
            onClose={opencode.clearError}
            onRetry={opencode.restart}
            onKillPort={opencode.killPortAndRestart}
          />

          {createDialog && (
            <InputDialog
              title={createDialog.type === "file" ? t("page.newFile") : t("page.newFolder")}
              placeholder={createDialog.type === "file" ? "file.tex" : "folder"}
              onConfirm={handleCreateConfirm}
              onCancel={() => setCreateDialog(null)}
              validator={validateFileName}
            />
          )}

          {showTemplateImport && (
            <TemplateImportDialog
              onClose={() => setShowTemplateImport(false)}
              onImported={handleOpenRecentProject}
            />
          )}
          {openFromServer !== false && (
            <OpenFromServer
              initial={openFromServer}
              onClose={() => setOpenFromServer(false)}
              onOpened={(path) => {
                setOpenFromServer(false);
                void handleOpenRecentProject(path);
              }}
            />
          )}
          <LaTeXSettingsDialog
            initialTab={settingsTab}
            open={showLatexSettings}
            onClose={() => setShowLatexSettings(false)}
            settings={latexSettings.settings}
            onUpdateSettings={latexSettings.updateSettings}
            editorSettings={editorSettings.settings}
            onUpdateEditorSettings={editorSettings.updateSettings}
            texFiles={texFiles}
            buildSettings={
              daemon.projectPath ? (
                <BuildTargetsEditor
                  project={daemon.projectPath}
                  config={latexSettings.settings.config}
                  texFiles={texFiles}
                  onSave={latexSettings.saveConfig}
                />
              ) : undefined
            }
          />

          <SynctexInstallDialog
            open={showSynctexInstallDialog}
            onClose={() => {
              setShowSynctexInstallDialog(false);
              pendingSynctexRetryRef.current = null;
            }}
            onInstallComplete={handleSynctexInstallComplete}
          />

          {git.publish.open && (
            <GitHubPublishDialog
              defaultRepoName={
                daemon.projectPath ? pathSync.basename(daemon.projectPath) : "my-project"
              }
              onPublish={git.publish.submit}
              onCancel={git.publish.cancel}
              isCreating={daemon.isCreatingRepo}
              error={git.publish.error}
            />
          )}
        </div>
      </TeamCommentsProvider>
    </AnnotationProvider>
  );
}
