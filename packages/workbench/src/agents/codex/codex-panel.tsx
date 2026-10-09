"use client";

import { ArrowUpIcon, PaperclipIcon, PlusIcon, StopIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  workbenchI18n as i18n,
  type WorkbenchKey as MessageKey,
  useWorkbenchI18n as useI18n,
} from "../../i18n";
import { ResizableComposer } from "../../ui/panel-height";
import { AttachmentStrip } from "../chat/attachment-strip";
import { useComposerDraft } from "../chat/composer-drafts";
import { DeliveryControls, type DeliveryMode } from "../chat/delivery-controls";
import { prepareChatFiles } from "../chat/files";
import { GrowingTextarea } from "../chat/growing-textarea";
import { ChatHistoryItems } from "../chat/history-items";
import { mergeById } from "../chat/idle-transcript";
import type { ChatImageFile } from "../chat/images";
import type { ChatDraft, ChatOutbox } from "../chat/outbox";
import { RenameChat } from "../chat/rename-chat";
import { useChatAttachments } from "../chat/use-chat-attachments";
import { useChatOutbox } from "../chat/use-chat-outbox";
import { useIdleTranscript } from "../chat/use-idle-transcript";
import { conversationTitle } from "../context";
import type { HarnessLifecycle } from "../harness/types";
import { usePanelLifecycle } from "../harness/use-panel-lifecycle";
import { agentPlatform, useBridge } from "../platform";
import {
  type EditorSelectionContext,
  selectionRangeLabel,
  withEditorSelection,
} from "../selection-context";
import {
  CODEX_BUSY_EVENT,
  CODEX_CHANGES_EVENT,
  CODEX_THREADS_EVENT,
  type CodexBackend,
  type CodexPermissionMode,
  type CodexModel as Model,
  type CodexThreadSummary as ThreadSummary,
} from "./backend";
import { shouldSendOnEnter } from "./composer-keys";
import { type CodexEvent, type CodexItem, itemsFromCodexThread, reduceCodexEvent } from "./events";

type Approval = { id: number | string; method: string; params: CodexEvent["params"] };

const PERMISSION_OPTIONS: Array<{
  value: CodexPermissionMode;
  label: MessageKey;
  description: MessageKey;
}> = [
  { value: "readOnly", label: "codex.readOnly", description: "codex.readsFilesEditsNeedApproval" },
  {
    value: "askForApproval",
    label: "codex.askForApproval",
    description: "codex.editsThisProjectAsksBeforeGoingOutsideIt",
  },
  {
    value: "autoReview",
    label: "codex.autoReviewApprovals",
    description: "codex.codexReviewsActionsThatNeedApproval",
  },
  {
    value: "fullAccess",
    label: "codex.fullAccess",
    description: "codex.noSandboxAndNoApprovalPrompts",
  },
];

function isPermissionMode(value: string | null): value is CodexPermissionMode {
  return PERMISSION_OPTIONS.some((option) => option.value === value);
}

type Props = HarnessLifecycle & {
  backend: CodexBackend;
  active?: boolean;
  onWorkingChange?: (busy: boolean) => void;
  directory?: string;
  editorSelection?: EditorSelectionContext | null;
  onClearSelection?: () => void;
  onSelectionSent?: (selection: EditorSelectionContext) => void;
  onBeforeSend?: (selection: EditorSelectionContext | null) => Promise<void>;
  onFileClick?: (path: string) => void;
  pendingMessage?: string | null;
  onPendingMessageSent?: () => void;
};

/** One line on what the shared runner did with the agent's file changes. */
function changeSummary(
  results: NonNullable<NonNullable<CodexEvent["params"]>["results"]>,
  t: ReturnType<typeof useI18n>["t"],
) {
  const applied = results.filter((r) => r.status === "applied").length,
    proposals = results.filter((r) => r.status === "proposal"),
    skipped = results.filter((r) => r.status === "skipped");
  return [
    applied ? t("codex.countFilesUpdatedInTheSharedProject", { count: applied }) : "",
    proposals.length
      ? t("codex.overlapsWithCollaboratorsKeptAsSuggestionsPaths", {
          paths: proposals.map((r) => r.path).join(", "),
        })
      : "",
    ...skipped.map((r) => `${r.path}: ${r.reason ?? ""}`),
  ]
    .filter(Boolean)
    .join(" · ");
}

function threadLabel(
  thread: ThreadSummary,
  fallback = i18n.t("codex.untitledConversation"),
): string {
  return thread.name?.trim() || conversationTitle(thread.preview) || fallback;
}

export function CodexPanel({
  backend,
  active = true,
  onWorkingChange,
  directory,
  editorSelection = null,
  onClearSelection,
  onSelectionSent,
  onBeforeSend,
  onFileClick,
  pendingMessage,
  onPendingMessageSent,
  ...lifecycle
}: Props) {
  const { t } = useI18n();
  const permissionSelectId = useId();
  const initialSession = useRef(lifecycle.initialSessionId);
  const [ready, setReady] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(lifecycle.initialSessionId ?? null);
  const [items, setItems] = useState<CodexItem[]>([]);
  useEffect(() => {
    const renamed = lifecycle.renamedConversation;
    if (renamed)
      setThreads((current) =>
        current.map((item) => (item.id === renamed.id ? { ...item, name: renamed.title } : item)),
      );
  }, [lifecycle.renamedConversation]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("steer");
  const [completion, setCompletion] = useState(0);
  const outboxRef = useRef<ChatOutbox | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<ChatImageFile[]>([]);
  useComposerDraft(
    directory,
    lifecycle.instanceId,
    input,
    setInput,
    attachedFiles,
    setAttachedFiles,
  );
  const attachments = useChatAttachments(
    attachedFiles,
    setAttachedFiles,
    active,
    preparing,
    directory,
  );
  const [turnId, setTurnId] = useState<string | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [showHistory, setShowHistory] = useState(false);

  const [permissionMode, setPermissionMode] = useState<CodexPermissionMode>("askForApproval");
  const currentThread = threads.find((t) => t.id === threadId);
  const bridge = useBridge(
    "codex",
    threadId,
    directory,
    currentThread ? threadLabel(currentThread, "Codex") : "Codex",
    busy || preparing,
    { model: model || null, effort: effort || null, permissionMode },
  );
  const bridgeWorking = bridge.working;
  /** Shared runner: the agents' changes to the project, and another member's running turn. */
  const [notice, setNotice] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<CodexPermissionMode[]>(
    PERMISSION_OPTIONS.map((o) => o.value),
  );
  useEffect(() => {
    onWorkingChange?.(busy || bridgeWorking);
  }, [busy, bridgeWorking, onWorkingChange]);
  const handleOpenExternal = useCallback((url: string) => {
    void agentPlatform().openExternal(url);
  }, []);
  const threadIdRef = useRef<string | null>(lifecycle.initialSessionId ?? null);
  const permissionModeRef = useRef<CodexPermissionMode>("askForApproval");
  const sendingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const pendingSentRef = useRef(false);
  const isComposingRef = useRef(false);
  const compositionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (compositionEndTimerRef.current) clearTimeout(compositionEndTimerRef.current);
    };
  }, []);

  const rememberThread = useCallback(
    (id: string | null) => {
      threadIdRef.current = id;
      initialSession.current = id;
      setThreadId(id);
      if (!directory) return;
      const key = `lmms-writer-codex-thread:${directory}`;
      if (id) localStorage.setItem(key, id);
      else localStorage.removeItem(key);
    },
    [directory],
  );

  const refreshThreads = useCallback(async () => {
    if (!directory) return;
    const response = await backend.listThreads(directory);
    setThreads(response.data ?? []);
  }, [directory, backend]);

  const openThread = useCallback(
    async (id: string) => {
      setError(null);
      pinnedRef.current = true;
      setBusy(false);
      setApproval(null);
      await backend.resumeThread(id, permissionModeRef.current);
      const response = await backend.readThread(id);
      rememberThread(id);
      setItems(itemsFromCodexThread(response.thread ?? {}));
      const latestTurn = response.thread?.turns?.at(-1);
      if (response.thread?.status?.type === "active" && latestTurn?.status === "inProgress") {
        setBusy(true);
        setTurnId(latestTurn.id ?? null);
      }
      setShowHistory(false);
    },
    [rememberThread, backend],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry generation intentionally retriggers the connection lifecycle.
  useEffect(() => {
    if (!directory) {
      setReady(false);
      setItems([]);
      rememberThread(null);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    setReady(false);
    setError(null);
    setItems([]);
    setApproval(null);
    threadIdRef.current = initialSession.current ?? null;
    setThreadId(initialSession.current ?? null);
    const savedPermission = localStorage.getItem(`lmms-writer-codex-permission:${directory}`);
    const nextPermission = isPermissionMode(savedPermission) ? savedPermission : "askForApproval";
    permissionModeRef.current = nextPermission;
    setPermissionMode(nextPermission);

    const boot = async () => {
      try {
        unlisten = await backend.listen((payload) => {
          if (cancelled) return;
          if (payload.method === CODEX_THREADS_EVENT) {
            void refreshThreads().catch(() => {});
            return;
          }
          if (payload.method === CODEX_BUSY_EVENT) {
            const busy = payload.params?.busy;
            setProjectBusy(
              busy && !busy.mine && busy.thread !== threadIdRef.current ? busy.userName : null,
            );
            return;
          }
          if (payload.method === "codex/connectionClosed") {
            setReady(false);
            setBusy(false);
            setError(t("codex.codexDisconnectedClickReconnect"));
            return;
          }
          const params = payload.params;
          if (params?.threadId && params.threadId !== threadIdRef.current) return;
          if (payload.id !== undefined && payload.method) {
            setApproval({ id: payload.id, method: payload.method, params });
            setAnswers({});
            return;
          }
          if (payload.method === CODEX_CHANGES_EVENT) {
            setNotice(changeSummary(payload.params?.results ?? [], t));
            return;
          }
          if (payload.method === "serverRequest/resolved") {
            setApproval((current) => (current?.id === params?.requestId ? null : current));
            return;
          }
          if (payload.method === "turn/started") {
            setTurnId(params?.turn?.id ?? null);
            setBusy(true);
          } else if (payload.method === "turn/completed") {
            setCompletion((value) => value + 1);
            if (
              params?.turn?.error ||
              params?.turn?.status === "interrupted" ||
              params?.turn?.status === "failed"
            ) {
              const queue = outboxRef.current;
              if (queue?.state.items.length)
                void queue.pause(t("codex.theLastTurnDidNotFinishTheQueueIsPaused"));
            }
            setBusy(false);
            setTurnId(null);
            if (params?.turn?.error?.message) setError(params.turn.error.message);
            void refreshThreads();
          } else if (payload.method === "error") {
            // willRetry errors are transient stream retries within the same turn.
            if (!params?.willRetry && outboxRef.current?.state.items.length)
              void outboxRef.current.pause(t("codex.anErrorOccurredTheQueueIsPaused"));
            setError(
              `${params?.error?.message ?? t("codex.codexFailed")}${params?.willRetry ? t("codex.retryingAutomatically") : ""}`,
            );
          } else if (payload.method === "warning" && params?.message) {
            setError(params.message);
          }
          if (payload.method?.startsWith("item/")) {
            setItems((current) => reduceCodexEvent(current, payload));
          }
        });
        await backend.initialize();
        const [catalog, history] = await Promise.all([
          backend.listModels(),
          backend.listThreads(directory),
        ]);
        if (cancelled) return;
        const modes = backend.permissions?.() ?? PERMISSION_OPTIONS.map((o) => o.value);
        setAllowed(modes);
        if (modes.length && !modes.includes(permissionModeRef.current)) {
          permissionModeRef.current = modes[0] as CodexPermissionMode;
          setPermissionMode(permissionModeRef.current);
        }
        setModels(catalog.data ?? []);
        const defaultModel =
          catalog.data?.find((candidate) => candidate.isDefault) ?? catalog.data?.[0];
        setModel(defaultModel?.model ?? defaultModel?.id ?? "");
        setEffort(defaultModel?.defaultReasoningEffort ?? "");
        setThreads(history.data ?? []);
        const remembered =
          threadIdRef.current ||
          (initialSession.current === undefined
            ? localStorage.getItem(`lmms-writer-codex-thread:${directory}`)
            : initialSession.current);
        if (remembered) {
          try {
            await openThread(remembered);
          } catch (cause) {
            // Keep the tab bound to its conversation; a transient failure must not turn it
            // into a disposable blank tab (its queue and history would disappear from view).
            if (!cancelled)
              setError(
                t("codex.couldNotRestoreThisCodexConversationClic", { error: String(cause) }),
              );
            return;
          }
        }
        if (cancelled) return;
        const pending = await backend.pendingRequests();
        if (cancelled) return;
        const activeRequest = pending.find(
          (request) => request.id !== undefined && request.params?.threadId === threadIdRef.current,
        );
        if (activeRequest?.id !== undefined && activeRequest.method) {
          setApproval({
            id: activeRequest.id,
            method: activeRequest.method,
            params: activeRequest.params,
          });
        }
        if (!cancelled) setReady(true);
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
    };
    void boot();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // A retry explicitly reruns the bootstrap; backend switches keep it mounted.
  }, [directory, openThread, refreshThreads, rememberThread, connectionAttempt, backend]);

  useEffect(() => {
    if (!active || !pinnedRef.current || (items.length === 0 && !approval)) return;
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [items, approval, active]);

  useEffect(() => {
    const history = historyRef.current;
    if (!history || !active) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) history.scrollTop = history.scrollHeight;
    });
    observer.observe(history);
    return () => observer.disconnect();
  }, [active]);

  const transmit = useCallback(
    async (draft: ChatDraft, steer = false): Promise<void> => {
      if (!ready || !directory || sendingRef.current)
        throw new Error(t("codex.notConnectedOrNotReadyToSendYet"));
      if (!steer && (busy || bridgeWorking)) throw new Error(t("codex.aTaskIsStillRunning"));
      if (steer && (!threadIdRef.current || !turnId))
        throw new Error(t("codex.theCurrentTurnHasEndedOrIsNotReadySendNo"));
      const expectedThread = threadIdRef.current;
      sendingRef.current = true;
      setPreparing(true);
      setError(null);
      let localId: string | undefined;
      try {
        await onBeforeSend?.(draft.selection);
        const payload = await prepareChatFiles(directory, draft.raw.trim(), draft.files);
        if (threadIdRef.current !== expectedThread)
          throw new Error(t("codex.theConversationChangedTheMessageWasNotSe"));
        let id = expectedThread;
        if (!id) {
          const result = await backend.startThread(directory, model || null, permissionMode);
          id = result.thread.id;
          rememberThread(id);
          void refreshThreads();
        }
        await bridge.register(id);
        const text = withEditorSelection(payload.text, draft.selection),
          images = payload.images.map((file) => file.url);
        localId = `local-${crypto.randomUUID()}`;
        setItems((current) => [
          ...current,
          {
            id: localId as string,
            type: "userMessage",
            content: [
              { type: "text", text: payload.text },
              ...images.map((url) => ({ type: "image", url })),
            ],
          },
        ]);
        setNotice(null);
        if (steer)
          await backend.steerTurn({ threadId: id, expectedTurnId: turnId as string, text, images });
        else {
          setBusy(true);
          const result = await backend.startTurn({
            threadId: id,
            text,
            images,
            model: model || null,
            effort: effort || null,
            permissionMode,
          });
          setTurnId(result.turn.id);
          // Codex titles a thread by its first input, which carries Writer's context.
          const title = !expectedThread && conversationTitle(payload.text);
          if (title)
            void backend
              .renameThread(id, title)
              .then(() => refreshThreads())
              .catch(() => {});
        }
      } catch (cause) {
        if (localId) setItems((current) => current.filter((item) => item.id !== localId));
        if (!steer) setBusy(false);
        setError(t("codex.sendingFailedError", { error: String(cause) }));
        throw cause;
      } finally {
        sendingRef.current = false;
        setPreparing(false);
      }
    },
    [
      ready,
      directory,
      busy,
      bridgeWorking,
      turnId,
      onBeforeSend,
      model,
      effort,
      permissionMode,
      rememberThread,
      refreshThreads,
      bridge.register,
      t,
      backend,
    ],
  );
  const outbox = useChatOutbox({
    scope: directory && threadId ? JSON.stringify(["codex", directory, threadId]) : null,
    ready,
    busy: busy || bridgeWorking || preparing,
    completion,
    deliver: (message) => transmit(message),
  });
  outboxRef.current = outbox;
  const idleHistory = useIdleTranscript({
    scope: `codex:${directory}:${lifecycle.instanceId}:${threadId}`,
    active,
    protectedWork:
      !ready ||
      busy ||
      preparing ||
      bridgeWorking ||
      Boolean(approval) ||
      Boolean(input.trim()) ||
      attachedFiles.length > 0 ||
      outbox.state.items.length > 0 ||
      Boolean(lifecycle.incoming),
    value: items,
    release: () => setItems([]),
    restore: (saved) => setItems((live) => mergeById(saved, live)),
  });

  const send = useCallback(
    async (raw: string): Promise<boolean> => {
      if (!ready || preparing || attachments.loading || (!raw.trim() && !attachedFiles.length))
        return false;
      const draft: ChatDraft = { raw, files: [...attachedFiles], selection: editorSelection };
      try {
        if ((busy || bridgeWorking) && deliveryMode === "queue") await outbox.enqueue(draft);
        else await transmit(draft, busy || bridgeWorking);
        setAttachedFiles((current) => current.filter((file) => !draft.files.includes(file)));
        setInput((current) => (current === raw ? "" : current));
        if (draft.selection) onSelectionSent?.(draft.selection);
        return true;
      } catch (cause) {
        setError(String(cause));
        return false;
      }
    },
    [
      ready,
      preparing,
      attachments.loading,
      attachedFiles,
      editorSelection,
      busy,
      bridgeWorking,
      deliveryMode,
      outbox,
      transmit,
      onSelectionSent,
    ],
  );

  useEffect(() => {
    if (!pendingMessage) {
      pendingSentRef.current = false;
      return;
    }
    if (!ready || pendingSentRef.current) return;
    pendingSentRef.current = true;
    void send(pendingMessage).then((sent) => {
      if (sent) onPendingMessageSent?.();
      else pendingSentRef.current = false;
    });
  }, [pendingMessage, ready, send, onPendingMessageSent]);

  usePanelLifecycle(
    lifecycle,
    {
      sessionId: threadId,
      title: currentThread
        ? threadLabel(currentThread, t("codex.newCodexConversation"))
        : t("codex.newCodexConversation"),
      status: approval
        ? "waiting"
        : busy || bridgeWorking || preparing
          ? "running"
          : error
            ? "error"
            : ready
              ? "idle"
              : "connecting",
      hasDraft: Boolean(input.trim() || attachedFiles.length || attachments.loading),
      queued: outbox.state.items.length,
    },
    {
      ready,
      busy: busy || bridgeWorking,
      preparing,
      transmit,
      enqueue: (draft) => outbox.enqueue(draft),
      onError: setError,
    },
  );

  const answerApproval = useCallback(
    async (decision: "accept" | "decline") => {
      if (!approval) return;
      try {
        let response: Record<string, unknown>;
        if (
          approval.method === "item/commandExecution/requestApproval" ||
          approval.method === "item/fileChange/requestApproval"
        ) {
          response = { decision };
        } else if (approval.method === "item/permissions/requestApproval") {
          response = {
            permissions: decision === "accept" ? (approval.params?.permissions ?? {}) : {},
            scope: "turn",
          };
        } else if (approval.method === "item/tool/requestUserInput") {
          response = {
            answers:
              decision === "accept"
                ? Object.fromEntries(
                    Object.entries(answers)
                      .filter(([, value]) => value.trim())
                      .map(([id, value]) => [id, { answers: [value.trim()] }]),
                  )
                : {},
          };
        } else if (approval.method === "mcpServer/elicitation/request") {
          response = { action: "decline", content: null };
        } else {
          setError(t("codex.codexNeedsThisHandledInATerminalMethod", { method: approval.method }));
          return;
        }
        await backend.respond(
          approval.params?.threadId ?? threadIdRef.current,
          approval.id,
          response,
        );
        setApproval(null);
      } catch (cause) {
        setError(t("codex.couldNotAnswerTheApprovalError", { error: String(cause) }));
      }
    },
    [approval, answers, t, backend],
  );

  const selectedModel = models.find((candidate) => (candidate.model ?? candidate.id) === model);
  const efforts =
    selectedModel?.supportedReasoningEfforts?.map((option) => option.reasoningEffort) ?? [];
  const permissionKey = PERMISSION_OPTIONS.find(
    (option) => option.value === permissionMode,
  )?.description;
  const permissionDescription = permissionKey ? t(permissionKey) : undefined;

  const handlePermissionModeChange = (value: string) => {
    if (!isPermissionMode(value)) return;
    permissionModeRef.current = value;
    setPermissionMode(value);
    if (directory) {
      localStorage.setItem(`lmms-writer-codex-permission:${directory}`, value);
    }
  };

  const handleCompositionStart = () => {
    if (compositionEndTimerRef.current) {
      clearTimeout(compositionEndTimerRef.current);
      compositionEndTimerRef.current = null;
    }
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    // WebKit can emit the confirming Enter after compositionend with isComposing=false.
    compositionEndTimerRef.current = setTimeout(() => {
      isComposingRef.current = false;
      compositionEndTimerRef.current = null;
    }, 0);
  };

  return (
    <div
      data-chat-panel="codex"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div
          className="min-w-0 truncate text-sm font-medium"
          title={currentThread ? threadLabel(currentThread, "Codex") : "Codex"}
        >
          {currentThread ? threadLabel(currentThread, "Codex") : "Codex"}
        </div>
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          {backend.shareThread && currentThread?.mine && threadId && (
            <button
              type="button"
              aria-pressed={!!currentThread.shared}
              onClick={() => {
                const shared = !currentThread.shared;
                void backend
                  .shareThread?.(threadId, shared)
                  .then(() =>
                    setThreads((current) =>
                      current.map((entry) =>
                        entry.id === threadId ? { ...entry, shared } : entry,
                      ),
                    ),
                  )
                  .catch((cause) => setError(String(cause)));
              }}
              className={`border px-2 py-1 text-xs ${currentThread.shared ? "border-accent text-accent" : "border-border hover:bg-accent-hover"}`}
              title={
                currentThread.shared
                  ? t("harness.sharedWithTheProjectClickToMakeItPrivate")
                  : t("harness.onlyYouCanSeeThisConversationClickToShar")
              }
            >
              {currentThread.shared ? t("harness.shared") : t("harness.private")}
            </button>
          )}
          {currentThread && currentThread.mine === false && (
            <span className="max-w-32 truncate text-xs text-muted">
              {t("codex.sharedByName", { name: currentThread.ownerName ?? "" })}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              if (lifecycle.onShowHistory) lifecycle.onShowHistory();
              else {
                setShowHistory((value) => !value);
                void refreshThreads();
              }
            }}
            className="border border-border px-2 py-1 text-xs hover:bg-accent-hover"
            title={t("codex.conversationHistory")}
          >
            {t("codex.history")}
          </button>
          <button
            type="button"
            onClick={() => {
              if (lifecycle.onNewConversation) {
                lifecycle.onNewConversation();
                return;
              }
              rememberThread(null);
              setItems([]);
              setBusy(false);
              setApproval(null);
              setShowHistory(false);
            }}
            className="flex size-7 items-center justify-center border border-border hover:bg-accent-hover"
            disabled={!lifecycle.onNewConversation && (busy || preparing)}
            title={t("codex.newConversation")}
            aria-label={t("codex.newConversation")}
          >
            <PlusIcon className="size-4" />
          </button>
        </div>
      </div>

      {bridge.view}
      {showHistory && (
        <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border p-2">
          {threads.length === 0 && (
            <p className="p-2 text-xs text-muted">
              {t("codex.noCodexConversationsInThisProjectYet")}
            </p>
          )}
          {threads.map((thread) => (
            <div
              key={thread.id}
              className={`group flex min-w-0 items-center ${threadId === thread.id ? "bg-accent-hover font-medium" : ""}`}
            >
              <button
                type="button"
                onClick={() => {
                  if (lifecycle.onOpenConversation)
                    lifecycle.onOpenConversation(thread.id, threadLabel(thread));
                  else void openThread(thread.id).catch((cause) => setError(String(cause)));
                  setShowHistory(false);
                }}
                className="min-w-0 flex-1 truncate px-2 py-2 text-left text-xs hover:bg-accent-hover group-has-[input]:hidden"
                disabled={!lifecycle.onOpenConversation && (busy || preparing)}
                title={threadLabel(thread)}
              >
                {threadLabel(thread)}
              </button>
              <RenameChat
                name={threadLabel(thread)}
                onRename={async (name) => {
                  await backend.renameThread(thread.id, name);
                  setThreads((current) =>
                    current.map((entry) => (entry.id === thread.id ? { ...entry, name } : entry)),
                  );
                }}
              />
            </div>
          ))}
        </div>
      )}

      <div
        ref={historyRef}
        onScroll={() => {
          const el = historyRef.current;
          if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        data-chat-history="codex"
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
      >
        {idleHistory.sleeping ? (
          <p role="status">
            {idleHistory.error || t("codex.restoringTheConversation")}
            {idleHistory.error && (
              <button type="button" onClick={idleHistory.retry}>
                {t("codex.retry")}
              </button>
            )}
          </p>
        ) : !directory ? (
          <p className="text-sm text-muted">{t("codex.openAProjectToUseCodex")}</p>
        ) : !ready && !error ? (
          <p className="text-sm text-muted">
            {backend.kind === "shared"
              ? t("codex.connectingToCodexOnTheSharedRunner")
              : t("codex.connectingToCodexOnThisComputer")}
          </p>
        ) : items.length === 0 ? (
          <div className="space-y-3 py-6 text-sm text-muted">
            <p className="font-medium text-foreground">
              {backend.kind === "shared"
                ? t("codex.runsOnTheLabRunnerAndEditsTheSharedProject")
                : t("codex.usesYourLocalCodexSignIn")}
            </p>
            <p>{t("codex.codexCanSearchTheLiteratureCheckSourcesA")}</p>
            <button
              type="button"
              onClick={() => setInput(t("codex.readTheRelevantPassagesOfTheCurrentPaper"))}
              className="border border-border px-2 py-1 text-xs text-foreground hover:bg-accent-hover"
            >
              {t("codex.fillInALiteratureSearchTask")}
            </button>
          </div>
        ) : null}
        <div className="space-y-3">
          <ChatHistoryItems
            items={items}
            directory={directory}
            onFileClick={onFileClick}
            onOpenExternal={handleOpenExternal}
          />
          {busy && (
            <div
              className="flex items-center gap-2 py-1 text-xs text-amber-700 dark:text-amber-300"
              role="status"
            >
              <span className="codex-activity-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {t("codex.codexIsWorking")}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {approval && (
        <div className="border-t border-border bg-accent-hover p-3 text-xs">
          <p className="font-medium text-foreground">{t("codex.codexAsksForConfirmation")}</p>
          <p className="mt-1 break-all text-muted">
            {approval.params?.reason ?? approval.params?.command ?? approval.method}
          </p>
          {approval.method === "item/tool/requestUserInput" &&
            approval.params?.questions?.map((question) => (
              <label key={question.id} className="mt-2 block text-foreground">
                <span>{question.question}</span>
                <input
                  value={answers[question.id] ?? ""}
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                  }
                  list={`codex-question-${question.id}`}
                  className="mt-1 w-full border border-border bg-background px-2 py-1 outline-none"
                />
                {question.options && (
                  <datalist id={`codex-question-${question.id}`}>
                    {question.options.map((option) => (
                      <option key={option.label} value={option.label} />
                    ))}
                  </datalist>
                )}
              </label>
            ))}
          {approval.method === "item/permissions/requestApproval" && (
            <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(approval.params?.permissions ?? {}, null, 2)}
            </pre>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void answerApproval("accept")}
              disabled={approval.method === "mcpServer/elicitation/request"}
              className="border border-foreground bg-foreground px-2 py-1 text-background"
            >
              {approval.method === "item/tool/requestUserInput"
                ? t("codex.submit")
                : t("codex.allow")}
            </button>
            <button
              type="button"
              onClick={() => void answerApproval("decline")}
              className="border border-border px-2 py-1"
            >
              {approval.method === "item/tool/requestUserInput" ? t("codex.skip") : t("codex.deny")}
            </button>
          </div>
        </div>
      )}
      {(notice || projectBusy) && (
        <div role="status" className="border-t border-border px-3 py-2 text-xs text-muted">
          {projectBusy && (
            <p>{t("codex.nameSAiConversationIsChangingTheProject", { name: projectBusy })}</p>
          )}
          {notice && <p>{notice}</p>}
        </div>
      )}
      {error && (
        <div role="alert" className="border-t border-border px-3 py-2 text-xs text-red-600">
          {error}
          {!ready && (
            <button
              type="button"
              className="ml-2 border border-border px-2 py-1"
              onClick={() => setConnectionAttempt((value) => value + 1)}
            >
              {t("codex.reconnect")}
            </button>
          )}
        </div>
      )}
      {editorSelection && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs">
          <span className="min-w-0 truncate">
            {t("agentsCommon.quotingPathRanges", {
              path: editorSelection.path,
              ranges: editorSelection.ranges
                .map(selectionRangeLabel)
                .join(t("agentsCommon.listSeparator")),
            })}
          </span>
          <button
            type="button"
            onClick={onClearSelection}
            className="flex-shrink-0 text-muted hover:text-foreground"
          >
            {t("codex.remove")}
          </button>
        </div>
      )}
      <ResizableComposer backend="codex">
        <fieldset
          aria-label={t("codex.messageAndAttachments")}
          ref={attachments.areaRef}
          onDragOver={(event) => event.preventDefault()}
          onDrop={attachments.onDrop}
          className="writer-composer-card"
        >
          <DeliveryControls
            mode={deliveryMode}
            onModeChange={setDeliveryMode}
            busy={busy || bridgeWorking}
            outbox={outbox}
          />
          <AttachmentStrip
            files={attachedFiles}
            disabled={preparing}
            onRemove={(index) =>
              setAttachedFiles((current) => current.filter((_, i) => i !== index))
            }
          />
          {attachments.error && (
            <p role="alert" className="py-2 text-xs text-red-600">
              {attachments.error}
            </p>
          )}
          {attachments.loading && (
            <p role="status" className="text-xs text-muted">
              {t("codex.addingAttachments")}
            </p>
          )}
          <GrowingTextarea
            value={input}
            onPaste={attachments.onPaste}
            onChange={(event) => setInput(event.target.value)}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onKeyDown={(event) => {
              if (
                shouldSendOnEnter(
                  {
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent.isComposing,
                    keyCode: event.nativeEvent.keyCode,
                  },
                  isComposingRef.current,
                )
              ) {
                event.preventDefault();
                void send(input);
              }
            }}
            placeholder={t("codex.askCodexToFindReferencesOrEditTheSelecti")}
            rows={3}
            className="writer-composer-input"
            aria-label={t("codex.messageToCodex")}
          />
          <div className="writer-composer-toolbar">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap text-xs text-muted">
              <label htmlFor={permissionSelectId} className="shrink-0">
                {t("codex.permissions")}
              </label>
              <select
                id={permissionSelectId}
                aria-label={t("codex.codexPermissions")}
                title={permissionDescription}
                value={permissionMode}
                onChange={(event) => handlePermissionModeChange(event.target.value)}
                disabled={!ready || busy}
                className="max-w-28 shrink-0 border border-border bg-background px-1.5 py-1 text-foreground outline-none focus-visible:border-foreground disabled:opacity-50"
              >
                {PERMISSION_OPTIONS.filter((option) => allowed.includes(option.value)).map(
                  (option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)}
                    </option>
                  ),
                )}
              </select>
              <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
              <select
                value={model}
                onChange={(event) => {
                  const next = event.target.value;
                  setModel(next);
                  const entry = models.find(
                    (candidate) => (candidate.model ?? candidate.id) === next,
                  );
                  setEffort(entry?.defaultReasoningEffort ?? "");
                }}
                aria-label={t("codex.codexModel")}
                className="min-w-24 max-w-36 flex-1 truncate border border-border bg-background px-1.5 py-1 text-foreground outline-none focus-visible:border-foreground"
              >
                <option value="">{t("codex.defaultModel")}</option>
                {models.map((entry) => (
                  <option key={entry.id} value={entry.model ?? entry.id}>
                    {entry.displayName ?? entry.model ?? entry.id}
                  </option>
                ))}
              </select>
              {efforts.length > 0 && (
                <select
                  value={effort}
                  onChange={(event) => setEffort(event.target.value)}
                  aria-label={t("codex.reasoningEffort")}
                  className="w-20 shrink-0 border border-border bg-background px-1.5 py-1 text-foreground outline-none focus-visible:border-foreground"
                >
                  <option value="">{t("codex.defaultEffort")}</option>
                  {efforts.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <input
              ref={attachments.pickerRef}
              type="file"
              accept={undefined}
              multiple
              className="hidden"
              onChange={(event) => {
                void attachments.addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => void attachments.choose()}
              disabled={preparing || attachments.loading}
              title={t("codex.addFilesOrImagesYouCanAlsoPasteOrDropThe")}
              aria-label={t("codex.addAttachment")}
              className="flex size-8 shrink-0 items-center justify-center border border-border hover:text-accent disabled:opacity-40"
            >
              <PaperclipIcon className="size-4" />
            </button>
            {busy && turnId && threadId && (
              <button
                type="button"
                onClick={() =>
                  void outbox
                    .pause(t("codex.taskStoppedTheQueueIsPaused"))
                    .catch(() => {})
                    .then(() => backend.interruptTurn(threadId, turnId))
                    .catch((cause) => setError(String(cause)))
                }
                title={t("codex.stop")}
                aria-label={t("codex.stopCodex")}
                className="flex size-8 items-center justify-center border border-border"
              >
                <StopIcon className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => void send(input)}
              disabled={
                !ready ||
                preparing ||
                attachments.loading ||
                (!input.trim() && !attachedFiles.length)
              }
              title={
                busy
                  ? deliveryMode === "queue"
                    ? t("codex.queue")
                    : t("codex.steerNow")
                  : t("codex.send")
              }
              aria-label={
                busy
                  ? deliveryMode === "queue"
                    ? t("codex.addToTheCodexQueue")
                    : t("codex.steerCodexNow")
                  : t("codex.sendToCodex")
              }
              className="flex size-8 items-center justify-center bg-foreground text-background disabled:opacity-40"
            >
              <ArrowUpIcon className="size-4" />
            </button>
          </div>
        </fieldset>
      </ResizableComposer>
    </div>
  );
}
