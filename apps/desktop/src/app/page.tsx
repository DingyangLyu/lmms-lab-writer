"use client";

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, type PanInfo, useReducedMotion } from "framer-motion";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoginCodeModal } from "@/components/auth";
import { ChatImageDirectory } from "@/components/chat/chat-image";
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
import {
  LaTeXInstallPrompt,
  LaTeXSettingsDialog,
  MainFileSelectionDialog,
  SynctexInstallDialog,
} from "@/components/latex";
import { BuildTargetsEditor, readCompilerOverrides } from "@/components/latex/build-targets-editor";
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
import { useAuth } from "@/lib/auth";
import { flushComposerDrafts } from "@/lib/chat/composer-drafts";
import { isWriterManagedPath } from "@/lib/chat/files";
import { parseChatLink } from "@/lib/chat/links";
import { useEditorSettings } from "@/lib/editor";
import { buildFileIndex, resolveFileReference } from "@/lib/editor/file-resolution";
import { ProjectTransition } from "@/lib/editor/project-transition";
import { projectRelativePath } from "@/lib/editor/save-manager";
import {
  type EditorSelectionContext,
  type EditorTextRange,
  sameEditorSelection,
  selectionMatchesDocument,
} from "@/lib/editor/selection-context";
import { useDocumentSaving } from "@/lib/editor/use-document-saving";
import { resolveLocalFile, revealInFileManager } from "@/lib/file-manager";
import type { ConversationTarget } from "@/lib/harness/types";
import { isHarnessId } from "@/lib/harness/types";
import { useHarnessWorkspace } from "@/lib/harness/use-workspace";
import { findTexFiles, useLatexCompiler, useLatexSettings } from "@/lib/latex";
import type {
  BuildTarget,
  LaTeXCompiler,
  MainFileDetectionResult,
  SynctexResult,
  TargetBuildResult,
} from "@/lib/latex/types";
import { makeBuildTarget } from "@/lib/latex/use-latex-settings";
import { pathSync } from "@/lib/path";
import { AnnotationProvider } from "@/lib/pdf/annotation-context";
import { annotationPrompt } from "@/lib/pdf/annotations";
import { useRecentProjects } from "@/lib/recent-projects";
import { useTauriDaemon } from "@/lib/tauri";

const PdfViewer = dynamic(
  () => import("@/components/editor/pdf-viewer").then((mod) => mod.PdfViewer),
  { ssr: false },
);

import {
  FolderOpenIcon,
  GearIcon,
  PlayCircleIcon,
  RobotIcon,
  SidebarSimpleIcon,
  TerminalIcon,
} from "@phosphor-icons/react";

function throttle<T extends (...args: Parameters<T>) => void>(fn: T, limit: number): T {
  let lastCall = 0;
  return ((...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      fn(...args);
    }
  }) as T;
}

function getReadableErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/^(load failed|failed to fetch|networkerror)$/i.test(message.trim())) {
    return fallback;
  }
  return message.trim() || fallback;
}

function getSynctexLookupMessage(error: unknown): string {
  const message = getReadableErrorMessage(error, "SyncTeX lookup failed.");
  if (message.includes("SYNCTEX_FILE_MISSING") || message.includes("No SyncTeX available")) {
    return "No SyncTeX data is available for this PDF. Recompile with SyncTeX enabled.";
  }
  return "SyncTeX lookup failed. Check that your PDF has a .synctex.gz file.";
}

type OpenCodeStatus = {
  running: boolean;
  port: number;
  installed: boolean;
  managed?: boolean;
  webSearchEnabled?: boolean;
};

type OpenCodeDaemonStatus = "stopped" | "starting" | "running" | "unavailable";
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

type ParsedUnifiedDiff = {
  original: string;
  modified: string;
  added: number;
  removed: number;
  hasRenderableHunks: boolean;
  isBinary: boolean;
};

function parseUnifiedDiffContent(content: string): ParsedUnifiedDiff {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let inHunk = false;
  let added = 0;
  let removed = 0;
  let isBinary = false;

  for (const line of lines) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      isBinary = true;
    }

    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line === "\\ No newline at end of file") continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      modifiedLines.push(line.slice(1));
      added += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      originalLines.push(line.slice(1));
      removed += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      const contextLine = line.slice(1);
      originalLines.push(contextLine);
      modifiedLines.push(contextLine);
      continue;
    }

    if (line.length === 0) {
      originalLines.push("");
      modifiedLines.push("");
    }
  }

  return {
    original: originalLines.join("\n"),
    modified: modifiedLines.join("\n"),
    added,
    removed,
    hasRenderableHunks: originalLines.length > 0 || modifiedLines.length > 0,
    isBinary,
  };
}

const AI_COMMIT_DIFF_LIMIT = 30000;
const AI_COMMIT_TIMEOUT_MS = 90000;
const OPENCODE_STORAGE_KEY_AGENT = "opencode-selected-agent";
const OPENCODE_STORAGE_KEY_MODEL = "opencode-selected-model";

type OpenCodeMessagePart = {
  type?: string;
  text?: string;
};

type OpenCodeMessageInfo = {
  id?: string;
  role?: string;
  parentID?: string;
  error?: {
    data?: {
      message?: string;
    };
  };
};

type OpenCodeMessageItem = {
  info?: OpenCodeMessageInfo;
  parts?: OpenCodeMessagePart[];
};

type PreferredOpenCodeConfig = {
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  variant?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTextParts(parts: OpenCodeMessagePart[] | undefined): string[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
}

function parseOpenCodeMessageResponse(data: unknown): OpenCodeMessageItem | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as OpenCodeMessageItem;
  return candidate;
}

function getPreferredOpenCodeConfig(): PreferredOpenCodeConfig {
  if (typeof window === "undefined") return {};

  let agent: string | undefined;
  let model:
    | {
        providerID: string;
        modelID: string;
      }
    | undefined;

  try {
    const savedAgent = localStorage.getItem(OPENCODE_STORAGE_KEY_AGENT);
    if (savedAgent) {
      agent = savedAgent;
    }

    const savedModelRaw = localStorage.getItem(OPENCODE_STORAGE_KEY_MODEL);
    if (savedModelRaw) {
      const savedModel = JSON.parse(savedModelRaw) as {
        providerId?: unknown;
        modelId?: unknown;
        variant?: unknown;
      };
      if (typeof savedModel.providerId === "string" && typeof savedModel.modelId === "string") {
        model = {
          providerID: savedModel.providerId,
          modelID: savedModel.modelId,
        };
        if (typeof savedModel.variant === "string" && savedModel.variant.length > 0) {
          return { agent, model, variant: savedModel.variant };
        }
      }
    }
  } catch {
    return {};
  }

  return { agent, model };
}

function sanitizeAiCommitMessage(raw: string): string {
  let text = raw.trim();

  text = text.replace(/^```[a-zA-Z]*\s*/m, "");
  text = text.replace(/\s*```$/, "");
  text = text.replace(/^commit message\s*[:：]\s*/i, "");

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text.trim();
}

function buildAiCommitPrompt(diff: string, scope: "staged" | "unstaged"): string {
  return [
    `Generate a git commit message from the following ${scope} changes.`,
    "Do not call tools. Only output the final commit message.",
    "Output rules:",
    "1. Return only the commit message text, no markdown and no code block.",
    "2. First line is a concise subject in imperative mood, <= 72 chars.",
    "3. Add a short body only when necessary.",
    "",
    "Diff:",
    diff,
  ].join("\n");
}

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

const _WEB_URL = process.env.NEXT_PUBLIC_WEB_URL || "https://writer.lmms-lab.com";

const MIN_PANEL_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

export default function EditorPage() {
  const editorSettings = useEditorSettings();
  const daemon = useTauriDaemon({
    gitAutoFetchEnabled: editorSettings.settings.gitAutoFetchEnabled,
    gitAutoFetchIntervalMs: editorSettings.settings.gitAutoFetchIntervalSeconds * 1000,
  });
  const prefersReducedMotion = useReducedMotion();
  const auth = useAuth();
  const { toast } = useToast();
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
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  /** Drafts are persisted; running or approval-waiting agents need explicit consent. */
  const confirmAgentsIdle = useCallback(async (action: "switch" | "quit") => {
    const busy = conversationsRef.current.tabs.filter(
      (t) => t.status === "running" || t.status === "waiting",
    );
    if (!busy.length) return true;
    const names = `${busy
      .slice(0, 3)
      .map((t) => `「${t.title}」`)
      .join("、")}${busy.length > 3 ? ` 等 ${busy.length} 个对话` : ""}`;
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(
      action === "quit"
        ? `${names}仍在执行或等待批准。退出 Writer 会中断这些任务，已完成的内容保留在对话历史中。确定退出？`
        : `${names}仍在执行或等待批准。切换项目后任务会在后台继续，需要批准的操作会等你回到此项目。确定切换？`,
      { title: action === "quit" ? "退出 Writer" : "切换项目", kind: "warning" },
    );
  }, []);
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
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("sidebarWidth");
      return saved ? parseInt(saved, 10) : 280;
    }
    return 280;
  });
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("rightPanelWidth");
      return saved ? parseInt(saved, 10) : 280;
    }
    return 280;
  });
  const [resizing, setResizing] = useState<"sidebar" | "right" | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"files" | "git">("files");
  const [highlightedFile, _setHighlightedFile] = useState<string | null>(null);

  const [commitMessage, setCommitMessage] = useState("");
  const [showCommitInput, setShowCommitInput] = useState(false);
  const [isGeneratingCommitMessageAI, setIsGeneratingCommitMessageAI] = useState(false);
  const [showRemoteInput, setShowRemoteInput] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [createDialog, setCreateDialog] = useState<{
    type: "file" | "directory";
  } | null>(null);
  const saving = useDocumentSaving(() => confirmAgentsIdle("quit"));
  const saveManager = saving.manager;
  const prepareEditorMessage = useCallback(
    async (selection: EditorSelectionContext | null) => {
      if (daemon.projectPath) await saveManager.synchronize(daemon.projectPath);
      if (!selection) return;
      if (selection.project !== daemon.projectPath)
        throw new Error("项目已切换，请重新选择需要引用的文本。");
      const content = await invoke<string>("read_document", {
        project: selection.project,
        path: selection.path,
      });
      if (!selectionMatchesDocument(selection, content))
        throw new Error("选区原文已变化，请重新选择后再发送，避免修改错误位置。");
      await invoke("checkpoint_document", {
        project: selection.project,
        path: selection.path,
        expected: content,
      });
    },
    [saveManager, daemon.projectPath],
  );
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ id: string; project: string; files?: string[]; checkpoint?: boolean }>(
          "writer://prepare-delivery",
          async ({ payload }) => {
            let error: string | null = null;
            try {
              await saveManager.synchronize(payload.project, payload.files);
              for (const doc of saveManager.documents.values()) {
                if (
                  payload.checkpoint !== false &&
                  doc.project === payload.project &&
                  (!payload.files || payload.files.includes(doc.path)) &&
                  /\.(tex|bib)$/i.test(doc.path)
                )
                  await invoke("checkpoint_document", {
                    project: doc.project,
                    path: doc.path,
                    expected: doc.content,
                  });
              }
            } catch (cause) {
              error = `委派前保存失败：${String(cause)}`;
            }
            await invoke("writer_delivery_prepared", { id: payload.id, error });
          },
        ),
      )
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [saveManager]);

  const primaryLoadRequestIdRef = useRef(0);
  const [fileLoadError, setFileLoadError] = useState<string | null>(null);
  const flushBeforeLeave = useCallback(async () => {
    try {
      await saveManager.flushAll();
      return true;
    } catch (error) {
      toast(`保存失败，操作已取消：${String(error)}`, "error");
      return false;
    }
  }, [saveManager, toast]);
  useEffect(() => {
    const project = daemon.projectPath;
    if (!project) return;
    void saveManager
      .recoverProject(project, (path) => invoke<string>("read_document", { project, path }))
      .catch((error) => toast(`恢复草稿读取失败：${String(error)}`, "error"));
  }, [daemon.projectPath, saveManager, toast]);
  const [opencodeDaemonStatus, setOpencodeDaemonStatus] = useState<OpenCodeDaemonStatus>("stopped");
  const [opencodePort, setOpencodePort] = useState(4096);
  const [showDisconnectedDialog, setShowDisconnectedDialog] = useState(false);
  const [showLatexSettings, setShowLatexSettings] = useState(false);
  const [showLoginCodeModal, setShowLoginCodeModal] = useState(false);
  const [pendingBackend, setPendingBackend] = useState<"opencode" | "codex" | "claude">("opencode");
  const [pendingOpenCodeMessage, setPendingOpenCodeMessage] = useState<string | null>(null);
  const [opencodeError, setOpencodeError] = useState<string | null>(null);

  const [showMainFileDialog, setShowMainFileDialog] = useState(false);
  const [mainFileDetectionResult, setMainFileDetectionResult] =
    useState<MainFileDetectionResult | null>(null);
  const [showGitHubPublishDialog, setShowGitHubPublishDialog] = useState(false);
  const [ghPublishError, setGhPublishError] = useState<string | null>(null);
  const [showSynctexInstallDialog, setShowSynctexInstallDialog] = useState(false);
  const pendingSynctexRetryRef = useRef<{
    page: number;
    x: number;
    y: number;
    context: "main" | "split";
  } | null>(null);

  const opencodeStartedForPathRef = useRef<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const gitDiffRequestIdRef = useRef(0);
  const splitLoadRequestIdRef = useRef(0);
  const editorWorkspaceRef = useRef<HTMLDivElement | null>(null);

  // RAF-based resize refs for 60fps performance
  const sidebarWidthRef = useRef(sidebarWidth);
  const rightPanelWidthRef = useRef(rightPanelWidth);
  const rafIdRef = useRef<number | null>(null);

  const gitStatus = daemon.gitStatus;
  const stagedChanges = useMemo(
    () => (gitStatus?.changes ?? []).filter((c: { staged: boolean; path: string }) => c.staged),
    [gitStatus?.changes],
  );
  const unstagedChanges = useMemo(
    () => (gitStatus?.changes ?? []).filter((c: { staged: boolean; path: string }) => !c.staged),
    [gitStatus?.changes],
  );

  // LaTeX settings and editor settings
  const latexSettings = useLatexSettings(daemon.projectPath);
  const [isCompiling, setIsCompiling] = useState(false);
  const compilingRef = useRef(false);
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

  // Ensure .lmms_lab_writer/COMPILE_NOTES.md exists
  const ensureCompileNotesFile = useCallback(async () => {
    if (!daemon.projectPath) return;

    const dirPath = ".lmms_lab_writer";
    const filePath = ".lmms_lab_writer/COMPILE_NOTES.md";

    try {
      // Try to read the file first to check if it exists
      await daemon.readFile(filePath);
    } catch {
      // File doesn't exist, create it
      try {
        await daemon.createDirectory(dirPath);
      } catch {
        // Directory might already exist, ignore
      }

      const initialContent = `# Compilation Notes

This file stores compilation preferences and notes for this LaTeX project.
The AI assistant will read and update this file during compilation.

## Project Info
- Created: ${new Date().toISOString()}

## Compilation History
(Notes will be added here by the AI assistant)
`;
      await daemon.writeFile(filePath, initialContent);
    }
  }, [daemon]);

  const queueCompileFailureForAgent = useCallback(
    async ({
      mainFile,
      compiler,
      compilerPath,
      args,
      error,
      exitCode,
    }: {
      mainFile: string;
      compiler: LaTeXCompiler;
      compilerPath: string | null;
      args: string[];
      error: string;
      exitCode?: number | null;
    }) => {
      if (!daemon.projectPath) return;

      const logFile = mainFile.replace(/\.tex$/i, ".log");
      let logTail = "";
      try {
        const logContent = await daemon.readFile(logFile);
        if (logContent) {
          const maxLogChars = 12000;
          logTail =
            logContent.length > maxLogChars
              ? `[Log truncated to last ${maxLogChars} characters]\n${logContent.slice(-maxLogChars)}`
              : logContent;
        }
      } catch {
        logTail = "(No .log file was available.)";
      }

      const implicitArgs = ["-interaction=nonstopmode", "-file-line-error", "-synctex=1"];
      const prompt = [
        "Local LaTeX compilation failed. Please diagnose and fix this project.",
        "",
        `Captured at: ${new Date().toISOString()}`,
        `Project directory: ${daemon.projectPath}`,
        `Main file: ${mainFile}`,
        `Compiler: ${compiler}`,
        `Compiler path used by the app: ${compilerPath ?? "(resolved from PATH)"}`,
        `Arguments: ${[...implicitArgs, ...args, mainFile].join(" ")}`,
        `Exit code: ${exitCode ?? "unknown"}`,
        `Reported error: ${error}`,
        "",
        "LaTeX log tail:",
        "~~~log",
        logTail || "(No log content was available.)",
        "~~~",
        "",
        agentBackend === "codex"
          ? "If current package documentation or a web-only error is relevant, use Codex web search and verify source URLs before relying on them."
          : "If the error depends on current package documentation, class behavior, or a web-only error message, use perplexity_search when available, websearch for discovery, and webfetch for source URLs. If websearch returns a 429 from Exa, fall back to perplexity_search or webfetch.",
        "Please inspect the relevant .tex, .bib, .sty, and .cls files, make the minimal fix needed to compile, rerun the local compilation, and summarize what changed.",
      ].join("\n");

      setPendingBackend(agentBackend);
      setPendingOpenCodeMessage(prompt);
      setShowRightPanel(true);
      if (agentBackend !== "opencode") {
        toast(
          agentBackend === "codex"
            ? "编译失败，日志已交给 Codex。"
            : "编译失败，日志已填入 Claude Code 输入框。",
          "error",
        );
        return;
      }

      try {
        const status = await invoke<OpenCodeStatus>("opencode_status");
        if (!status.installed) {
          setOpencodeDaemonStatus("unavailable");
          toast(
            "Compilation failed. OpenCode is not installed, so the Agent cannot be started.",
            "error",
          );
          return;
        }

        if (
          status.running &&
          status.managed &&
          opencodeStartedForPathRef.current === daemon.projectPath
        ) {
          setOpencodeDaemonStatus("running");
          setOpencodePort(status.port);
          toast("Compilation failed. Sent the log to Agent.", "error");
          return;
        }

        setOpencodeDaemonStatus("starting");
        setOpencodeError(null);
        const startedStatus = await invoke<OpenCodeStatus>("opencode_start", {
          directory: daemon.projectPath,
          port: 4096,
        });
        setOpencodeDaemonStatus("running");
        setOpencodePort(startedStatus.port);
        opencodeStartedForPathRef.current = daemon.projectPath;
        toast("Compilation failed. Sent the log to Agent.", "error");
      } catch (agentError) {
        const message = agentError instanceof Error ? agentError.message : String(agentError);
        setOpencodeDaemonStatus("stopped");
        setOpencodeError(message);
        toast("Compilation failed. Could not start the Agent automatically.", "error");
      }
    },
    [agentBackend, daemon, toast],
  );

  const runDirectCompile = useCallback(
    async (target: BuildTarget) => {
      if (!daemon.projectPath || compilingRef.current) return;
      if (!(await flushBeforeLeave())) return;
      compilingRef.current = true;
      setIsCompiling(true);
      toast(`正在编译 ${target.name} · ${target.mainFile}`);
      try {
        const result = await invoke<TargetBuildResult>("latex_build_target", {
          directory: daemon.projectPath,
          target,
          compilerOverrides: readCompilerOverrides(),
        });
        if (!result.success || !result.pdfPath || !result.pdfRelative) {
          await queueCompileFailureForAgent({
            mainFile: target.mainFile,
            compiler: result.engine as LaTeXCompiler,
            compilerPath: result.compilerPath,
            args: [],
            error: `${result.error || "编译失败"}\n${result.output}`,
            exitCode: null,
          });
          return;
        }
        const pdfFile = result.pdfRelative;
        setEditorViewMode("file");
        setGitDiffPreview(null);
        setOpenTabs((prev) => (prev.includes(pdfFile) ? prev : [...prev, pdfFile]));
        setSelectedFile(pdfFile);
        setBinaryPreviewUrl(convertFileSrc(result.pdfPath));
        setFileContent("");
        setPdfRefreshKey((key) => key + 1);
        void daemon.refreshFiles();
        toast(`编译完成：${pdfFile}（${result.engine}）`);
      } catch (cause) {
        toast(`编译未完成：${String(cause)}`, "error");
      } finally {
        compilingRef.current = false;
        setIsCompiling(false);
      }
    },
    [daemon, flushBeforeLeave, queueCompileFailureForAgent, toast],
  );
  const handleCompileWithDetection = useCallback(async () => {
    if (!daemon.projectPath || latexSettings.isDetecting || latexSettings.saving) return;
    await ensureCompileNotesFile();
    const target = latexSettings.activeTarget;
    if (target) {
      await runDirectCompile(target);
      return;
    }
    setShowLatexSettings(true);
    toast("请在设置中添加或扫描编译目标。", "error");
  }, [
    daemon.projectPath,
    latexSettings.isDetecting,
    latexSettings.saving,
    latexSettings.activeTarget,
    ensureCompileNotesFile,
    runDirectCompile,
    toast,
  ]);
  const handleMainFileSelect = useCallback(
    async (mainFile: string) => {
      const target =
        latexSettings.settings.config.targets.find((t) => t.mainFile === mainFile) ||
        makeBuildTarget(mainFile);
      await latexSettings.setMainFile(mainFile);
      setShowMainFileDialog(false);
      setMainFileDetectionResult(null);
      await runDirectCompile(target);
    },
    [latexSettings, runDirectCompile],
  );
  const handleMainFileDialogCancel = useCallback(() => {
    setShowMainFileDialog(false);
    setMainFileDetectionResult(null);
  }, []);

  const checkOpencodeStatus = useCallback(async () => {
    try {
      const status = await invoke<OpenCodeStatus>("opencode_status");
      if (!status.installed) {
        setOpencodeDaemonStatus("unavailable");
      } else if (status.running && status.managed) {
        setOpencodeDaemonStatus("running");
        setOpencodePort(status.port);
      } else if (status.running) {
        setOpencodeDaemonStatus("stopped");
      } else {
        setOpencodeDaemonStatus("stopped");
      }
      return status;
    } catch {
      setOpencodeDaemonStatus("unavailable");
      return null;
    }
  }, []);

  const startOpencode = useCallback(
    async (directory: string) => {
      try {
        setOpencodeDaemonStatus("starting");
        setOpencodeError(null);
        const status = await invoke<OpenCodeStatus>("opencode_start", {
          directory,
          port: 4096,
        });
        setOpencodeDaemonStatus("running");
        setOpencodePort(status.port);
        opencodeStartedForPathRef.current = directory;
        return status;
      } catch (err) {
        console.error(`Failed to start OpenCode: ${getReadableErrorMessage(err, "Unknown error")}`);
        const message = getReadableErrorMessage(err, "Failed to start OpenCode");
        setOpencodeDaemonStatus(message.includes("OpenCode not found") ? "unavailable" : "stopped");
        setOpencodeError(message);
        toast(message, "error");
        return null;
      }
    },
    [toast],
  );

  const restartOpencode = useCallback(async () => {
    if (!daemon.projectPath) {
      toast("Please open a project first.", "error");
      return;
    }

    // If status is "unavailable", re-check if OpenCode is now installed
    if (opencodeDaemonStatus === "unavailable") {
      const status = await checkOpencodeStatus();
      if (!status?.installed) {
        toast(
          "OpenCode is still not installed. Please install it first:\nnpm i -g opencode-ai@latest\nor\nbrew install sst/tap/opencode",
          "error",
        );
        return;
      }
      const started = await startOpencode(daemon.projectPath);
      if (started) toast("OpenCode started successfully!", "success");
      return;
    }

    try {
      setOpencodeDaemonStatus("starting");
      setOpencodeError(null);
      const currentStatus = await invoke<OpenCodeStatus>("opencode_status");

      if (!currentStatus.installed) {
        setOpencodeDaemonStatus("unavailable");
        setOpencodeError(
          "OpenCode is not installed. Please install it first using npm or Homebrew.",
        );
        return;
      }

      const status = await invoke<OpenCodeStatus>("opencode_restart", {
        directory: daemon.projectPath,
      });
      setOpencodeDaemonStatus("running");
      setOpencodePort(status.port);
      opencodeStartedForPathRef.current = daemon.projectPath;
      toast("OpenCode started successfully!", "success");
    } catch (err) {
      const errorMessage = getReadableErrorMessage(err, "Failed to start OpenCode");
      console.error(`Failed to start OpenCode: ${errorMessage}`);
      setOpencodeDaemonStatus("stopped");
      setOpencodeError(errorMessage);
    }
  }, [daemon.projectPath, opencodeDaemonStatus, toast, checkOpencodeStatus, startOpencode]);

  const handleMaxReconnectFailed = useCallback(() => {
    setShowDisconnectedDialog(true);
  }, []);

  const handleCloseDisconnectedDialog = useCallback(() => {
    setShowDisconnectedDialog(false);
  }, []);

  const handleRestartFromDialog = useCallback(() => {
    setShowDisconnectedDialog(false);
    restartOpencode();
  }, [restartOpencode]);

  const handleCloseErrorDialog = useCallback(() => {
    setOpencodeError(null);
  }, []);

  const handleKillPort = useCallback(
    async (port: number) => {
      await invoke("kill_port_process", { port });
      setOpencodeError(null);
      await restartOpencode();
    },
    [restartOpencode],
  );

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

  const hasOpenCodeTabs = conversations.tabs.some((t) => t.backend === "opencode");
  useEffect(() => {
    if (!hasOpenCodeTabs || !daemon.projectPath) return;
    let cancelled = false;
    const projectPath = daemon.projectPath;
    void checkOpencodeStatus().then((status) => {
      if (cancelled || !status?.installed) return;
      if (status.running && status.managed && opencodeStartedForPathRef.current === projectPath) {
        return;
      }
      void startOpencode(projectPath);
    });
    return () => {
      cancelled = true;
    };
  }, [hasOpenCodeTabs, daemon.projectPath, checkOpencodeStatus, startOpencode]);

  useEffect(() => {
    localStorage.setItem("sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem("rightPanelWidth", String(rightPanelWidth));
  }, [rightPanelWidth]);

  useEffect(() => {
    checkOpencodeStatus();
  }, [checkOpencodeStatus]);

  useEffect(() => {
    if (pendingGoToLine > 0) {
      // Give the editor time to load new file content before clearing
      const timer = setTimeout(() => setPendingGoToLine(0), 3000);
      return () => clearTimeout(timer);
    }
  }, [pendingGoToLine]);

  useEffect(() => {
    if (!daemon.projectPath) {
      opencodeStartedForPathRef.current = null;
      setSplitPane(null);
    }
  }, [daemon.projectPath]);

  useEffect(() => {
    setShowTerminal(Boolean(daemon.projectPath));
  }, [daemon.projectPath]);

  // Listen for opencode logs from Tauri backend
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ type: string; message: string }>("opencode-log", (event) => {
        const { type, message } = event.payload;
        if (type === "stderr") {
          console.error("[OpenCode]", message);
        }
      }).then((fn) => {
        unlisten = fn;
      });
    });

    return () => {
      unlisten?.();
    };
  }, []);

  const startResize = useCallback(
    (panel: "sidebar" | "right") => {
      setResizing(panel);
      sidebarWidthRef.current = sidebarWidth;
      rightPanelWidthRef.current = rightPanelWidth;
      document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
      document.documentElement.style.setProperty("--right-panel-width", `${rightPanelWidth}px`);
    },
    [sidebarWidth, rightPanelWidth],
  );

  const handleResizeDrag = useCallback((panel: "sidebar" | "right", info: PanInfo) => {
    if (rafIdRef.current !== null) return;

    rafIdRef.current = requestAnimationFrame(() => {
      if (panel === "sidebar") {
        const newWidth = Math.min(Math.max(info.point.x, MIN_PANEL_WIDTH), MAX_SIDEBAR_WIDTH);
        sidebarWidthRef.current = newWidth;
        document.documentElement.style.setProperty("--sidebar-width", `${newWidth}px`);
      } else if (panel === "right") {
        const maxRightWidth = Math.floor(window.innerWidth / 2);
        const newWidth = Math.min(
          Math.max(window.innerWidth - info.point.x, MIN_PANEL_WIDTH),
          maxRightWidth,
        );
        rightPanelWidthRef.current = newWidth;
        document.documentElement.style.setProperty("--right-panel-width", `${newWidth}px`);
      }
      rafIdRef.current = null;
    });
  }, []);

  const endResize = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setSidebarWidth(sidebarWidthRef.current);
    setRightPanelWidth(rightPanelWidthRef.current);
    document.documentElement.style.removeProperty("--sidebar-width");
    document.documentElement.style.removeProperty("--right-panel-width");
    setResizing(null);
  }, []);

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

  const getFileType = useCallback((path: string): "text" | "image" | "pdf" | "binary" => {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const lowerPath = path.toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) {
      return "image";
    }
    if (ext === "pdf") {
      return "pdf";
    }
    if (
      lowerPath.endsWith(".synctex.gz") ||
      [
        "ppt",
        "pptx",
        "pps",
        "ppsx",
        "potx",
        "doc",
        "docx",
        "xls",
        "xlsx",
        "odt",
        "odp",
        "ods",
        "key",
        "numbers",
        "pages",
        "exe",
        "dmg",
        "mp3",
        "mp4",
        "mov",
        "zip",
        "gz",
        "tgz",
        "tar",
        "bz2",
        "xz",
        "7z",
        "rar",
        "dvi",
        "ttf",
        "otf",
        "woff",
        "woff2",
        "eot",
        "ds_store",
      ].includes(ext)
    ) {
      return "binary";
    }
    return "text";
  }, []);

  const getFileLanguage = useCallback((path: string): string => {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const languageMap: Record<string, string> = {
      tex: "latex",
      sty: "latex",
      cls: "latex",
      bib: "bibtex",
      js: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      py: "python",
      md: "markdown",
      json: "json",
      css: "css",
      scss: "scss",
      less: "less",
      html: "html",
      htm: "html",
      xml: "xml",
      yaml: "yaml",
      yml: "yaml",
      sh: "shell",
      bash: "shell",
      zsh: "shell",
      c: "c",
      cpp: "cpp",
      h: "c",
      hpp: "cpp",
      java: "java",
      rs: "rust",
      go: "go",
      rb: "ruby",
      php: "php",
      sql: "sql",
      r: "r",
      lua: "lua",
      swift: "swift",
      kt: "kotlin",
      scala: "scala",
      toml: "toml",
      ini: "ini",
      conf: "ini",
      dockerfile: "dockerfile",
      makefile: "makefile",
    };
    return languageMap[ext] || "plaintext";
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
        if (
          local.directory ||
          local.projectPath === null ||
          getFileType(resolvedPath) === "binary"
        ) {
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
      const fileType = getFileType(resolvedPath);

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
            toast(`File "${fileName}" no longer exists and has been removed from tabs`, "error");

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
            toast(`Failed to read file: ${err}`, "error");
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
    [daemon, getFileType, resolveSelectablePath, toast, saveManager, flushBeforeLeave],
  );

  const [pendingPdfPage, setPendingPdfPage] = useState<{ path: string; page: number } | null>(null);
  const handleChatFileClick = useCallback(
    async (reference: string) => {
      const target = parseChatLink(reference, daemon.projectPath ?? undefined);
      if (target.kind === "external-file") {
        try {
          await revealInFileManager(daemon.projectPath ?? "", target.path);
          toast(`已在文件管理器中定位 ${pathSync.basename(target.path)}`);
        } catch (cause) {
          toast(`无法打开文件所在文件夹：${String(cause)}`, "error");
        }
        return;
      }
      if (target.kind !== "file") {
        toast("这个链接不属于当前项目。", "error");
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
    [daemon.projectPath, handleFileSelect, toast, fileIndex, latexSettings.activeTarget],
  );

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ href: string }>(
          "writer://open-link",
          ({ payload }) => void handleChatFileClick(payload.href),
        ),
      )
      .then((unlisten) => {
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
    if (!event || !project || getFileType(event.path) !== "text") return;
    const doc = saveManager.get(project, event.path);
    if (!doc) return;
    if (["modify", "create", "rename", "remove"].includes(event.kind))
      void saveManager.synchronizeDocument(doc).catch(() => {});
  }, [daemon.lastFileChange, daemon.projectPath, getFileType, saveManager]);
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
      const fileType = getFileType(resolvedPath);
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
            toast(`File "${pathSync.basename(resolvedPath)}" no longer exists`, "error");
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
      getFileType,
      resolveSelectablePath,
      toast,
      selectedFile,
      handleFileSelect,
      saveManager,
      flushBeforeLeave,
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
      const splitFileType = splitSelectedFile ? getFileType(splitSelectedFile) : "text";

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
                Drag a tab here to open a second editor group.
              </div>
            ) : splitPane.isLoading ? (
              <EditorSkeleton className="h-full" />
            ) : splitPane.error ? (
              <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                Failed to load file: {splitPane.error}
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
                    在文件管理器中显示
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
                    此文件无法预览 · 在文件管理器中显示
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
                  language={getFileLanguage(splitSelectedFile)}
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
      getFileType,
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
      getFileLanguage,
      editorSettings.settings,
      editorSettings.editorTheme,
      toast,
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
      { id: "files", label: "Files" },
      {
        id: "git",
        label: "Git",
        badge: gitStatus && gitStatus.changes.length > 0 ? gitStatus.changes.length : undefined,
      },
    ],
    [gitStatus],
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
          choose,
          confirm: async () => {
            if (compilingRef.current || latexSettings.saving)
              throw new Error("编译或配置保存仍在进行，请完成后再切换文件夹。");
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
              toast(`文件夹已打开，但最近项目记录未保存：${String(error)}`, "error"),
            );
      } catch (err) {
        console.error("Failed to open project:", err);
        toast(`切换文件夹已取消，当前项目和草稿已保留：${String(err)}`, "error");
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
    ],
  );
  const handleOpenFolder = useCallback(
    () =>
      changeProject(async () => {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          directory: true,
          multiple: false,
          title: "打开文件夹",
          defaultPath: daemon.projectPath ? pathSync.dirname(daemon.projectPath) : undefined,
        });
        return typeof selected === "string" ? selected : null;
      }),
    [changeProject, daemon.projectPath],
  );
  const handleOpenRecentProject = useCallback(
    (path: string) => changeProject(async () => path),
    [changeProject],
  );

  const handleStageAll = useCallback(() => {
    if (!gitStatus) return;
    const unstaged = gitStatus.changes
      .filter((c: { staged: boolean }) => !c.staged)
      .map((c: { path: string }) => c.path);
    if (unstaged.length > 0) {
      daemon.gitAdd(unstaged);
    }
  }, [gitStatus, daemon]);

  const handleStageFile = useCallback(
    (path: string) => {
      daemon.gitAdd([path]);
    },
    [daemon],
  );

  const handleUnstageAll = useCallback(() => {
    const stagedPaths = (daemon.gitStatus?.changes ?? [])
      .filter((c: { staged: boolean }) => c.staged)
      .map((c: { path: string }) => c.path);
    if (stagedPaths.length > 0) {
      daemon.gitUnstage(stagedPaths);
    }
  }, [daemon]);

  const handleUnstageFile = useCallback(
    (path: string) => {
      daemon.gitUnstage([path]);
    },
    [daemon],
  );

  const handleRemoteSubmit = useCallback(() => {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return;
    daemon.gitAddRemote(trimmed);
    setRemoteUrl("");
    setShowRemoteInput(false);
  }, [daemon, remoteUrl]);

  const handleGitPush = useCallback(async () => {
    const result = await daemon.gitPush();
    if (result.success) {
      toast("Changes pushed successfully", "success");
    } else {
      toast(result.error || "Failed to push changes", "error");
    }
  }, [daemon, toast]);

  const handleGitPull = useCallback(async () => {
    const result = await daemon.gitPull();
    if (result.success) {
      toast("Changes pulled successfully", "success");
    } else {
      toast(result.error || "Failed to pull changes", "error");
    }
  }, [daemon, toast]);

  const handleRefreshGitStatus = useCallback(() => {
    void daemon.refreshGitStatus(true);
  }, [daemon]);

  const handleDiscardAll = useCallback(async () => {
    if (!(await flushBeforeLeave())) return;
    const result = await daemon.gitDiscardAll();
    if (result.success) {
      toast("All changes discarded", "success");
    } else {
      toast(result.error || "Failed to discard changes", "error");
    }
  }, [daemon, toast, flushBeforeLeave]);

  const handleDiscardFile = useCallback(
    async (path: string) => {
      if (!(await flushBeforeLeave())) return;
      const result = await daemon.gitDiscardFile(path);
      if (result.success) {
        toast(`Discarded changes: ${path}`, "success");
      } else {
        toast(result.error || "Failed to discard file", "error");
      }
    },
    [daemon, toast, flushBeforeLeave],
  );

  const handlePublishToGitHub = useCallback(async () => {
    setGhPublishError(null);

    const status = await daemon.ghCheck();
    if (!status.installed) {
      toast("GitHub CLI (gh) is not installed. Install it from https://cli.github.com", "error");
      return;
    }

    if (!status.authenticated) {
      if (daemon.isAuthenticatingGh) {
        toast("GitHub authentication is already in progress in the terminal window.", "info");
        return;
      }

      toast(
        "Terminal opened for GitHub login. Complete prompts there (type Y when asked), then continue in browser.",
        "info",
      );
      const loginResult = await daemon.ghAuthLogin();
      if (!loginResult.success || !loginResult.authenticated) {
        toast(loginResult.error || "GitHub authentication failed", "error");
        return;
      }
      toast("Authenticated with GitHub", "success");
    }

    setShowGitHubPublishDialog(true);
  }, [daemon, toast]);

  const handleGitHubPublish = useCallback(
    async (name: string, isPrivate: boolean, description: string) => {
      setGhPublishError(null);
      const result = await daemon.ghCreateRepo(name, isPrivate, description || undefined);
      if (result.success) {
        setShowGitHubPublishDialog(false);
        toast(`Repository published: ${result.url}`, "success");
      } else {
        setGhPublishError(result.error || "Failed to create repository");
      }
    },
    [daemon, toast],
  );

  const runOpenCodePrompt = useCallback(
    async (prompt: string): Promise<string> => {
      if (!daemon.projectPath) {
        throw new Error("Project path is missing");
      }

      const baseUrl = `http://localhost:${opencodePort}`;
      const query = `?directory=${encodeURIComponent(daemon.projectPath)}`;
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-opencode-directory": encodeURIComponent(daemon.projectPath),
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), AI_COMMIT_TIMEOUT_MS);
      let sessionId: string | null = null;

      try {
        const createSessionResponse = await fetch(`${baseUrl}/session${query}`, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
          signal: controller.signal,
        });

        if (!createSessionResponse.ok) {
          const errorText = await createSessionResponse.text().catch(() => "");
          throw new Error(
            `Failed to create OpenCode session: ${createSessionResponse.status} ${errorText}`,
          );
        }

        const sessionData = (await createSessionResponse.json()) as {
          id?: string;
        };
        if (!sessionData.id) {
          throw new Error("OpenCode session response missing id");
        }
        sessionId = sessionData.id;
        const preferred = getPreferredOpenCodeConfig();
        const requestBody: {
          parts: Array<{ type: "text"; text: string }>;
          noReply: boolean;
          agent?: string;
          model?: { providerID: string; modelID: string };
          variant?: string;
        } = {
          parts: [{ type: "text", text: prompt }],
          noReply: false,
        };
        if (preferred.agent) {
          requestBody.agent = preferred.agent;
        }
        if (preferred.model) {
          requestBody.model = preferred.model;
        }
        if (preferred.variant) {
          requestBody.variant = preferred.variant;
        }

        const messageResponse = await fetch(`${baseUrl}/session/${sessionId}/message${query}`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!messageResponse.ok) {
          const errorText = await messageResponse.text().catch(() => "");
          throw new Error(`OpenCode message failed: ${messageResponse.status} ${errorText}`);
        }

        const messageDataRaw = (await messageResponse.json()) as unknown;
        const messageData = parseOpenCodeMessageResponse(messageDataRaw);
        const initialText = extractTextParts(messageData?.parts).join("\n").trim();
        if (initialText) {
          return initialText;
        }

        const parentMessageId =
          messageData?.info?.role === "user" ? messageData.info.id : undefined;
        const startedAt = Date.now();
        while (Date.now() - startedAt < AI_COMMIT_TIMEOUT_MS) {
          const messagesResponse = await fetch(`${baseUrl}/session/${sessionId}/message${query}`, {
            method: "GET",
            headers,
            signal: controller.signal,
          });

          if (!messagesResponse.ok) {
            const errorText = await messagesResponse.text().catch(() => "");
            throw new Error(
              `Failed to poll OpenCode messages: ${messagesResponse.status} ${errorText}`,
            );
          }

          const messagesData = (await messagesResponse.json()) as unknown;
          const items = Array.isArray(messagesData)
            ? (messagesData as OpenCodeMessageItem[])
            : messagesData &&
                typeof messagesData === "object" &&
                Array.isArray((messagesData as { messages?: OpenCodeMessageItem[] }).messages)
              ? (messagesData as { messages: OpenCodeMessageItem[] }).messages
              : [];

          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            if (!item) continue;
            const info = item?.info;
            if (info?.role !== "assistant") continue;
            if (parentMessageId && info.parentID && info.parentID !== parentMessageId) {
              continue;
            }

            const text = extractTextParts(item.parts).join("\n").trim();
            if (text) {
              return text;
            }

            const errorMessage = info.error?.data?.message;
            if (errorMessage) {
              throw new Error(errorMessage);
            }
          }

          await sleep(500);
        }

        throw new Error("OpenCode returned an empty response");
      } finally {
        clearTimeout(timeoutId);
        if (sessionId) {
          void fetch(`${baseUrl}/session/${sessionId}${query}`, {
            method: "DELETE",
            headers,
          }).catch(() => {});
        }
      }
    },
    [daemon.projectPath, opencodePort],
  );

  const handleGenerateCommitMessageAI = useCallback(async () => {
    if (!daemon.projectPath) {
      toast("Please open a project first.", "error");
      return;
    }

    if (stagedChanges.length === 0) {
      toast("Stage files before generating commit message.", "error");
      return;
    }

    setShowCommitInput(true);
    setIsGeneratingCommitMessageAI(true);

    try {
      const status = await checkOpencodeStatus();
      if (!status?.installed) {
        toast("OpenCode is not installed. Run: npm i -g opencode-ai@latest", "error");
        return;
      }

      if (!status.running) {
        const started = await startOpencode(daemon.projectPath);
        if (!started) {
          toast("Failed to start OpenCode daemon.", "error");
          return;
        }
      }

      const diffChunks: string[] = await Promise.all(
        stagedChanges.map((change: { path: string }) => daemon.gitDiff(change.path, true)),
      );
      const mergedDiff = diffChunks
        .filter((chunk: string) => chunk.trim().length > 0)
        .join("\n\n")
        .slice(0, AI_COMMIT_DIFF_LIMIT)
        .trim();

      if (!mergedDiff) {
        toast("No textual staged diff available.", "error");
        return;
      }

      const prompt = buildAiCommitPrompt(mergedDiff, "staged");
      const aiRaw = await runOpenCodePrompt(prompt);
      const aiMessage = sanitizeAiCommitMessage(aiRaw);

      if (!aiMessage) {
        toast("AI returned an empty commit message.", "error");
        return;
      }

      setCommitMessage(aiMessage);
      toast("AI commit draft generated.", "success");
    } catch (error) {
      const errorMessage = getReadableErrorMessage(
        error,
        "Could not reach OpenCode. Start or restart the Agent and try again.",
      );
      console.error(`Failed to generate AI commit message: ${errorMessage}`);
      toast(`AI draft failed: ${errorMessage}`, "error");
    } finally {
      setIsGeneratingCommitMessageAI(false);
    }
  }, [daemon, stagedChanges, checkOpencodeStatus, startOpencode, runOpenCodePrompt, toast]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    const result = await daemon.gitCommit(commitMessage.trim());
    if (result.success) {
      toast("Changes committed", "success");
      setCommitMessage("");
      setShowCommitInput(false);
    } else {
      toast(result.error || "Failed to commit", "error");
    }
  }, [commitMessage, daemon, toast]);

  const validateFileName = useCallback((name: string): string | null => {
    if (!name.trim()) {
      return "Name cannot be empty";
    }
    if (name.includes("/") || name.includes("\\")) {
      return "Name cannot contain / or \\";
    }
    if (name.startsWith(".")) {
      return "Name cannot start with .";
    }
    return null;
  }, []);

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
        toast(`Failed to create: ${error}`, "error");
      }
    },
    [createDialog, daemon, toast],
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
                  <span>{gitDiffPreview.staged ? "Staged changes" : "Working tree changes"}</span>
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
                  Refresh Diff
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleFileSelect(gitDiffPreview.path);
                  }}
                  className="btn btn-sm btn-secondary"
                >
                  Open File
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0">
              {gitDiffPreview.isLoading ? (
                <EditorSkeleton className="h-full" />
              ) : gitDiffPreview.error ? (
                <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                  Failed to load diff: {gitDiffPreview.error}
                </div>
              ) : parsedGitDiff?.isBinary ? (
                <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                  Binary file diff is not previewable in editor.
                </div>
              ) : !gitDiffPreview.content.trim() ? (
                <div className="h-full flex items-center justify-center px-6 text-sm text-muted">
                  No textual diff available for this file.
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
            {getFileType(selectedFile) === "image" ? (
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
            ) : getFileType(selectedFile) === "pdf" ? (
              <PdfViewer
                src={binaryPreviewUrl}
                project={daemon.projectPath ?? undefined}
                pdfPath={selectedFile}
                goToPage={pendingPdfPage?.path === selectedFile ? pendingPdfPage.page : undefined}
                refreshKey={pdfRefreshKey}
                onSynctexClick={handleSynctexClick}
              />
            ) : getFileType(selectedFile) === "binary" ? (
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
                  在文件管理器中显示
                </button>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center overflow-auto p-4">
                <div className="flex flex-col items-center gap-3 text-sm text-muted">
                  <p>此文件无法在编辑器中预览。</p>
                  <button
                    type="button"
                    className="border border-border px-3 py-2"
                    onClick={() =>
                      void revealInFileManager(daemon.projectPath ?? "", selectedFile).catch(
                        (cause) => toast(String(cause), "error"),
                      )
                    }
                  >
                    在文件管理器中显示
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : fileLoadError ? (
          <div role="alert" className="p-4 text-accent">
            文件读取失败，编辑已暂停：{fileLoadError}
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
                language={getFileLanguage(selectedFile)}
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
          Drop a tab here to open this panel.
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
      {switchingProject && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-[250] flex items-center justify-center bg-background/70"
        >
          <p className="border border-border bg-background px-5 py-3 text-sm shadow-md">
            正在保存当前内容并打开文件夹…
          </p>
        </div>
      )}
      <div className="h-dvh flex flex-col" inert={switchingProject}>
        <div className="flex-shrink-0 flex flex-col">
          <header className="h-12 border-b border-border flex items-center">
            <div className="w-full px-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    import("@tauri-apps/plugin-shell").then(({ open }) => {
                      open("https://writer.lmms-lab.com");
                    });
                  }}
                  className="hover:opacity-70 transition-opacity flex items-center"
                  title="Visit writer.lmms-lab.com"
                  aria-label="Open LMMs-Lab website"
                >
                  <Image
                    src="/logo-small-light.svg"
                    alt="LMMs-Lab Writer"
                    width={140}
                    height={28}
                    className="h-7 w-auto dark:hidden"
                  />
                  <Image
                    src="/logo-small-dark.svg"
                    alt="LMMs-Lab Writer"
                    width={140}
                    height={28}
                    className="h-7 w-auto hidden dark:block"
                  />
                </button>
                <span className="text-border">/</span>
                <div className="flex items-center gap-2 min-w-0">
                  <div className="text-sm font-medium px-2 py-1 -ml-2 truncate">
                    {daemon.projectPath ? pathSync.basename(daemon.projectPath) : "LMMs-Lab Writer"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleOpenFolder()}
                  disabled={choosingProject || daemon.isOpeningProject}
                  aria-label="打开文件夹"
                  title="打开文件夹（⌘/Ctrl+O），先保存当前修改"
                  className="flex h-8 shrink-0 items-center gap-1.5 border border-border px-2 text-xs hover:bg-accent-hover disabled:opacity-50"
                >
                  <FolderOpenIcon className="size-4" aria-hidden="true" />
                  <span className="hidden sm:inline">
                    {choosingProject ? "正在打开…" : "打开文件夹"}
                  </span>
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
                    title="Toggle Sidebar"
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
                    title="Toggle Terminal"
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
                  title="Toggle Agent Mode"
                >
                  <RobotIcon className="size-4" weight="bold" />
                </button>

                {daemon.projectPath && (
                  <>
                    <span className="text-border text-lg select-none">/</span>
                    <div className="flex items-center gap-2 h-8">
                      <select
                        aria-label="编译目标"
                        value={latexSettings.settings.config.activeTarget ?? ""}
                        disabled={isCompiling || latexSettings.isDetecting || latexSettings.saving}
                        onChange={(event) =>
                          void latexSettings.selectTarget(event.target.value).catch(() => {})
                        }
                        className="h-8 max-w-40 truncate border border-border bg-background px-2 text-xs"
                      >
                        {!latexSettings.settings.config.targets.length && (
                          <option value="">添加编译目标…</option>
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
                        title="从 ZIP 或文件夹创建新项目"
                      >
                        导入模板
                      </button>

                      <button
                        type="button"
                        onClick={handleCompileWithDetection}
                        disabled={isCompiling || latexSettings.isDetecting || latexSettings.saving}
                        className={`h-8 w-8 border border-border transition-colors flex items-center justify-center bg-background text-foreground ${
                          latexSettings.isDetecting
                            ? "opacity-50 cursor-not-allowed"
                            : "hover:bg-accent-hover hover:border-border-dark"
                        }`}
                        title={isCompiling ? "正在编译…" : "编译所选目标 (Ctrl+Shift+B)"}
                      >
                        <PlayCircleIcon className="size-4" />
                      </button>
                      {isCompiling && (
                        <button
                          type="button"
                          onClick={() =>
                            void invoke("latex_stop_compilation").catch((cause) =>
                              toast(String(cause), "error"),
                            )
                          }
                          className="h-8 border border-border px-2 text-xs"
                        >
                          停止编译
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setShowLatexSettings(true)}
                        className="h-8 w-8 border border-border bg-background text-foreground hover:bg-accent-hover hover:border-border-dark transition-colors flex items-center justify-center"
                        title="Settings"
                        aria-label="Settings"
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
                  `合并冲突 ${conflict.id} 已由用户处理并保存。请重新读取 ${conflict.path}${conflict.annotationId ? ` 与批注 ${conflict.annotationId}` : ""}，尊重用户的合并结果，不要重放旧提案；核验后继续完成批注。`,
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
            编译配置：{latexSettings.error}
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
                        stagedChanges={stagedChanges}
                        unstagedChanges={unstagedChanges}
                        showRemoteInput={showRemoteInput}
                        remoteUrl={remoteUrl}
                        onRemoteUrlChange={(value) => setRemoteUrl(value)}
                        onShowRemoteInput={() => setShowRemoteInput(true)}
                        onHideRemoteInput={() => setShowRemoteInput(false)}
                        onSubmitRemote={handleRemoteSubmit}
                        onInitGit={daemon.gitInit}
                        isInitializingGit={daemon.isInitializingGit}
                        onRefreshStatus={handleRefreshGitStatus}
                        onStageAll={handleStageAll}
                        onDiscardAll={handleDiscardAll}
                        onDiscardFile={handleDiscardFile}
                        onStageFile={handleStageFile}
                        onUnstageFile={handleUnstageFile}
                        onUnstageAll={handleUnstageAll}
                        showCommitInput={showCommitInput}
                        commitMessage={commitMessage}
                        onCommitMessageChange={(value) => setCommitMessage(value)}
                        onShowCommitInput={() => setShowCommitInput(true)}
                        onHideCommitInput={() => setShowCommitInput(false)}
                        onCommit={handleCommit}
                        onPush={handleGitPush}
                        onPull={handleGitPull}
                        onPreviewDiff={handlePreviewGitDiff}
                        onGenerateCommitMessageAI={handleGenerateCommitMessageAI}
                        onOpenFile={(path) => {
                          void handleFileSelect(path);
                        }}
                        onPublishToGitHub={handlePublishToGitHub}
                        isGeneratingCommitMessageAI={isGeneratingCommitMessageAI}
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

                <DockviewPanelLayout panels={editorPanelItems} className="dockview-editor-layout" />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                {daemon.projectPath ? (
                  <div />
                ) : (
                  <div className="flex flex-col items-center justify-center text-center px-6">
                    <Image
                      src="/logo-light.svg"
                      alt="LMMs-Lab Writer"
                      width={320}
                      height={96}
                      className="h-24 w-auto mb-10 dark:hidden"
                    />
                    <Image
                      src="/logo-dark.svg"
                      alt="LMMs-Lab Writer"
                      width={320}
                      height={96}
                      className="h-24 w-auto mb-10 hidden dark:block"
                    />
                    <button type="button" onClick={handleOpenFolder} className="btn btn-primary">
                      Open Folder
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowTemplateImport(true)}
                      className="mt-3 border border-border px-4 py-2 text-sm"
                    >
                      导入 LaTeX 模板（ZIP／文件夹）
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
                          editorSelection?.project === daemon.projectPath ? editorSelection : null,
                        onClearSelection: () => setEditorSelection(null),
                        onSelectionSent: (sent) =>
                          setEditorSelection((current) =>
                            sameEditorSelection(current, sent) ? null : current,
                          ),
                        onBeforeSend: prepareEditorMessage,
                      }}
                      opencode={{
                        baseUrl: `http://localhost:${opencodePort}`,
                        autoConnect: opencodeDaemonStatus === "running" && !!daemon.projectPath,
                        daemonStatus: opencodeDaemonStatus,
                        onRestartOpenCode: restartOpencode,
                        onMaxReconnectFailed: handleMaxReconnectFailed,
                      }}
                    />
                  </ChatImageDirectory.Provider>
                </aside>
              </div>
            )}
          </AnimatePresence>
        </main>

        <OpenCodeDisconnectedDialog
          open={showDisconnectedDialog}
          onClose={handleCloseDisconnectedDialog}
          onRestart={handleRestartFromDialog}
        />

        <OpenCodeErrorDialog
          open={!!opencodeError}
          error={opencodeError ?? ""}
          onClose={handleCloseErrorDialog}
          onRetry={restartOpencode}
          onKillPort={handleKillPort}
        />

        {createDialog && (
          <InputDialog
            title={createDialog.type === "file" ? "New File" : "New Folder"}
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
        <LaTeXSettingsDialog
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
          authLoading={auth.loading}
          authConfigured={auth.isConfigured}
          authProfile={auth.profile}
          authError={auth.error}
          onOpenLogin={() => {
            setShowLatexSettings(false);
            setShowLoginCodeModal(true);
          }}
          onSignOut={auth.signOut}
        />

        {mainFileDetectionResult && (
          <MainFileSelectionDialog
            open={showMainFileDialog}
            detectionResult={mainFileDetectionResult}
            onSelect={handleMainFileSelect}
            onCancel={handleMainFileDialogCancel}
          />
        )}

        <SynctexInstallDialog
          open={showSynctexInstallDialog}
          onClose={() => {
            setShowSynctexInstallDialog(false);
            pendingSynctexRetryRef.current = null;
          }}
          onInstallComplete={handleSynctexInstallComplete}
        />

        {showGitHubPublishDialog && (
          <GitHubPublishDialog
            defaultRepoName={
              daemon.projectPath ? pathSync.basename(daemon.projectPath) : "my-project"
            }
            onPublish={handleGitHubPublish}
            onCancel={() => {
              setShowGitHubPublishDialog(false);
              setGhPublishError(null);
            }}
            isCreating={daemon.isCreatingRepo}
            error={ghPublishError}
          />
        )}

        <LoginCodeModal
          isOpen={showLoginCodeModal}
          onClose={() => setShowLoginCodeModal(false)}
          onSuccess={async (accessToken) => {
            if (accessToken) {
              // Session storage failed, use access token directly
              await auth.setAuthWithToken(accessToken);
            } else {
              // Session was stored properly, refresh normally
              await auth.refreshAuth();
            }
          }}
        />
      </div>
    </AnnotationProvider>
  );
}
