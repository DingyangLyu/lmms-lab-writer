"use client";
import { ArrowUpIcon, PaperclipIcon, PlusIcon, StopIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkbenchI18n as useI18n } from "../../i18n";
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
import { ShareToggle } from "../chat/share-toggle";
import { changeSummary, SharedRunnerNotice } from "../chat/shared-runner-notice";
import { useChatAttachments } from "../chat/use-chat-attachments";
import { useChatOutbox } from "../chat/use-chat-outbox";
import { useIdleTranscript } from "../chat/use-idle-transcript";
import { shouldSendOnEnter } from "../codex/composer-keys";
import type { HarnessLifecycle } from "../harness/types";
import { useAutoReconnect } from "../harness/use-auto-reconnect";
import { usePanelLifecycle } from "../harness/use-panel-lifecycle";
import { useBridge } from "../platform";
import {
  type EditorSelectionContext,
  selectionRangeLabel,
  withEditorSelection,
} from "../selection-context";
import {
  CLAUDE_SESSIONS_EVENT,
  type ClaudeBackend,
  type ClaudeModel as Model,
  type ClaudeSession as Session,
} from "./backend";
import { type ClaudeEvent, type ClaudeMessages, reduceClaudeEvent } from "./events";

const PERMISSIONS = [
  {
    value: "default",
    label: "claude.askForApproval",
    description: "claude.asksEachTimeAPermissionIsNeeded",
  },
  {
    value: "acceptEdits",
    label: "claude.autoEdit",
    description: "claude.approvesFileEditsAutomaticallySomeComman",
  },
  {
    value: "bypassPermissions",
    label: "claude.noApprovals",
    description: "claude.commandsAndFileEditsNeedNoApprovalClaude",
  },
  {
    value: "plan",
    label: "claude.planOnly",
    description: "claude.analysesAndPlansFirstEditsStillNeedAppro",
  },
] as const;
type PermissionMode = (typeof PERMISSIONS)[number]["value"];
const isPermissionMode = (value: string | null): value is PermissionMode =>
  PERMISSIONS.some((option) => option.value === value);
type Props = HarnessLifecycle & {
  backend: ClaudeBackend;
  active: boolean;
  directory?: string;
  onWorkingChange: (busy: boolean) => void;
  onFileClick: (path: string) => void;
  editorSelection: EditorSelectionContext | null;
  onClearSelection: () => void;
  onSelectionSent: (selection: EditorSelectionContext) => void;
  onBeforeSend: (selection: EditorSelectionContext | null) => Promise<void>;
  pendingMessage?: string | null;
  onPendingMessageSent?: () => void;
};
export function ClaudePanel({
  backend,
  active,
  directory,
  onWorkingChange,
  onFileClick,
  editorSelection,
  onClearSelection,
  onSelectionSent,
  onBeforeSend,
  pendingMessage,
  onPendingMessageSent,
  ...lifecycle
}: Props) {
  const { t } = useI18n();
  const initialSession = useRef(lifecycle.initialSessionId);
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const reconnectSoon = useAutoReconnect(backend.kind === "shared", () =>
    setRetry((value) => value + 1),
  );
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(lifecycle.initialSessionId ?? null);
  const sessionRef = useRef<string | null>(lifecycle.initialSessionId ?? null);
  const [messages, setMessages] = useState<ClaudeMessages>({ items: [], messageId: "" });
  useEffect(() => {
    const renamed = lifecycle.renamedConversation;
    if (renamed)
      setSessions((current) =>
        current.map((item) => (item.id === renamed.id ? { ...item, name: renamed.title } : item)),
      );
  }, [lifecycle.renamedConversation]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("steer");
  const [completion, setCompletion] = useState(0);
  const outboxRef = useRef<ChatOutbox | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("default");
  const [effort, setEffort] = useState("high");
  const [permission, setPermission] = useState<PermissionMode>("default");
  const [history, setHistory] = useState(false);
  const [approvals, setApprovals] = useState<ClaudeEvent[]>([]);
  /** Shared runner: the agent's changes to the project, and another member's running turn. */
  const [notice, setNotice] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<ChatImageFile[]>([]);
  useComposerDraft(directory, lifecycle.instanceId, input, setInput, files, setFiles);
  const attachments = useChatAttachments(files, setFiles, active, preparing, directory);
  const composing = useRef(false);
  const compositionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sending = useRef(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const remember = useCallback(
    (id: string | null) => {
      sessionRef.current = id;
      initialSession.current = id;
      setSessionId(id);
      if (directory) {
        if (id) localStorage.setItem(`writer-claude-session:${directory}`, id);
        else localStorage.removeItem(`writer-claude-session:${directory}`);
      }
    },
    [directory],
  );
  const bridge = useBridge(
    "claude",
    sessionId,
    directory,
    sessions.find((s) => s.id === sessionId)?.name || "Claude Code",
    busy || preparing,
    { model, effort, permissionMode: permission },
  );
  const bridgeWorking = bridge.working;
  const [allowed, setAllowed] = useState<PermissionMode[]>(PERMISSIONS.map((p) => p.value));
  const refresh = useCallback(async () => {
    if (directory) setSessions(await backend.listSessions(directory));
  }, [directory, backend]);
  const openSession = useCallback(
    async (id: string) => {
      if (!directory) return;
      const saved = await backend.readSession(directory, id);
      remember(id);
      pinned.current = true;
      setMessages(saved.events.reduce(reduceClaudeEvent, { items: [], messageId: "" }));
      setBusy(saved.busy);
      setApprovals(saved.pending);
      setHistory(false);
      setError("");
    },
    [directory, remember, backend],
  );
  useEffect(() => {
    onWorkingChange(busy || preparing || bridgeWorking);
  }, [busy, preparing, bridgeWorking, onWorkingChange]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry intentionally restarts the connection lifecycle.
  useEffect(() => {
    if (!directory) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setReady(false);
    setBusy(false);
    setSessions([]);
    setError("");
    setMessages({ items: [], messageId: "" });
    setApprovals([]);
    const savedPermission = localStorage.getItem(`lmms-writer-claude-permission:${directory}`);
    setPermission(isPermissionMode(savedPermission) ? savedPermission : "default");
    sessionRef.current = initialSession.current ?? null;
    setSessionId(initialSession.current ?? null);
    void (async () => {
      unlisten = await backend.listen((payload) => {
        if (disposed) return;
        if (payload.event.type === CLAUDE_SESSIONS_EVENT) {
          void refresh().catch(() => {});
          return;
        }
        if (payload.event.type === "writer_busy") {
          const other = payload.event.busy;
          setProjectBusy(
            other && !other.mine && other.thread !== sessionRef.current ? other.userName : null,
          );
          return;
        }
        if (payload.event.type === "writer_disconnected") {
          setReady(false);
          setBusy(false);
          setError(t("agentsCommon.lostTheServerReconnecting"));
          reconnectSoon();
          return;
        }
        if (
          (payload.directory && payload.directory !== directory) ||
          payload.sessionId !== sessionRef.current
        )
          return;
        const event = payload.event;
        if (event.type === "writer_changes") {
          setNotice(changeSummary(event.results ?? [], t));
          return;
        }
        setMessages((current) => reduceClaudeEvent(current, event));
        if (event.type === "control_request")
          setApprovals((current) => [
            ...current.filter((a) => a.request_id !== event.request_id),
            event,
          ]);
        if (event.type === "control_cancel_request")
          setApprovals((current) => current.filter((a) => a.request_id !== event.request_id));
        if (event.type === "writer_error") {
          setError(event.error || t("claude.claudeCodeFailed"));
          if (outboxRef.current?.state.items.length)
            void outboxRef.current.pause(t("claude.theRunFailedTheQueueIsPaused"));
        }
        if (event.type === "result" && event.is_error) {
          setError(event.errors?.join("\n") || event.result || t("claude.claudeCodeFailed"));
          if (outboxRef.current?.state.items.length)
            void outboxRef.current.pause(t("claude.theRunFailedTheQueueIsPaused"));
        }
        if (event.type === "writer_started") setBusy(true);
        if (event.type === "writer_done") {
          setCompletion((value) => value + 1);
          setBusy(false);
          setApprovals([]);
          void refresh();
        }
        if (event.type === "writer_steering") {
          setApprovals([]);
          setAnswers({});
        }
      });
      if (disposed) {
        unlisten?.();
        return;
      }
      const [catalog] = await Promise.all([backend.initialize(directory), refresh()]);
      if (disposed) return;
      setModels(catalog.models || []);
      const modes = backend.permissions?.() ?? PERMISSIONS.map((p) => p.value);
      setAllowed(modes);
      setPermission((current) => (modes.includes(current) ? current : (modes[0] ?? current)));
      const previous =
        sessionRef.current ||
        (initialSession.current === undefined
          ? localStorage.getItem(`writer-claude-session:${directory}`)
          : initialSession.current);
      if (previous) {
        try {
          await openSession(previous);
        } catch (cause) {
          // Stay bound to the saved session instead of silently becoming a blank tab.
          if (!disposed)
            setError(
              t("claude.couldNotRestoreThisClaudeCodeConversatio", { error: String(cause) }),
            );
          return;
        }
      }
      if (!disposed) setReady(true);
    })().catch((cause) => {
      if (disposed) return;
      setError(String(cause));
      reconnectSoon(10_000);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [directory, retry, openSession, remember, refresh, backend]);
  useEffect(() => {
    const el = historyRef.current;
    if (!el || !active) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (active && pinned.current && messages.items.length) {
      const el = historyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [active, messages]);
  useEffect(
    () => () => {
      if (compositionTimer.current) clearTimeout(compositionTimer.current);
    },
    [],
  );
  const transmit = useCallback(
    async (draft: ChatDraft, steer = false) => {
      if (!ready || sending.current || !directory)
        throw new Error(t("claude.notConnectedOrNotReadyToSendYet"));
      if (!steer && (busy || bridgeWorking)) throw new Error(t("claude.aTaskIsStillRunning"));
      const expectedSession = sessionRef.current;
      sending.current = true;
      setPreparing(true);
      setError("");
      try {
        await onBeforeSend(draft.selection);
        const payload = await prepareChatFiles(directory, draft.raw, draft.files);
        if (sessionRef.current !== expectedSession)
          throw new Error(t("claude.theConversationChangedTheMessageWasNotSe"));
        let id = expectedSession;
        if (!id) {
          if (steer) throw new Error(t("claude.noConversationIsRunning"));
          const session = await backend.createSession(directory);
          id = session.id;
          remember(id);
        }
        await bridge.register(id);
        pinned.current = true;
        setNotice(null);
        if (steer)
          await backend.steerTurn({
            directory,
            sessionId: id,
            text: withEditorSelection(payload.text, draft.selection),
            images: payload.images.map((file) => file.url),
          });
        else {
          setBusy(true);
          await backend.startTurn({
            directory,
            sessionId: id,
            text: withEditorSelection(payload.text, draft.selection),
            images: payload.images.map((file) => file.url),
            options: { model, effort: effort || null, permissionMode: permission },
          });
        }
        void refresh();
      } catch (cause) {
        if (!steer) setBusy(false);
        setError(String(cause));
        throw cause;
      } finally {
        sending.current = false;
        setPreparing(false);
      }
    },
    [
      ready,
      directory,
      busy,
      bridgeWorking,
      bridge.register,
      onBeforeSend,
      remember,
      model,
      effort,
      permission,
      refresh,
      t,
      backend,
    ],
  );
  const outbox = useChatOutbox({
    scope: directory && sessionId ? JSON.stringify(["claude", directory, sessionId]) : null,
    ready,
    busy: busy || bridgeWorking || preparing,
    completion,
    deliver: (message) => transmit(message),
  });
  outboxRef.current = outbox;
  const idleHistory = useIdleTranscript({
    scope: `claude:${directory}:${lifecycle.instanceId}:${sessionId}`,
    active,
    protectedWork:
      !ready ||
      busy ||
      preparing ||
      bridgeWorking ||
      approvals.length > 0 ||
      Boolean(input.trim()) ||
      files.length > 0 ||
      outbox.state.items.length > 0 ||
      Boolean(lifecycle.incoming),
    value: messages,
    release: () => setMessages({ items: [], messageId: "" }),
    restore: (saved) =>
      setMessages((live) => ({
        items: mergeById(saved.items, live.items),
        messageId: live.messageId || saved.messageId,
      })),
  });

  const send = useCallback(
    async (raw: string) => {
      if (!ready || preparing || attachments.loading || (!raw.trim() && !files.length)) return;
      const draft: ChatDraft = { raw, files: [...files], selection: editorSelection };
      try {
        if (busy && deliveryMode === "queue") await outbox.enqueue(draft);
        else await transmit(draft, busy);
        setInput((current) => (current === raw ? "" : current));
        setFiles((current) => current.filter((file) => !draft.files.includes(file)));
        if (draft.selection) onSelectionSent(draft.selection);
      } catch (cause) {
        setError(String(cause));
      }
    },
    [
      ready,
      preparing,
      attachments.loading,
      files,
      editorSelection,
      busy,
      deliveryMode,
      outbox,
      transmit,
      onSelectionSent,
    ],
  );
  useEffect(() => {
    if (active && pendingMessage && ready && !busy) {
      setInput(pendingMessage);
      onPendingMessageSent?.();
    }
  }, [active, pendingMessage, ready, busy, onPendingMessageSent]);
  usePanelLifecycle(
    lifecycle,
    {
      sessionId,
      title:
        sessions.find((s) => s.id === sessionId)?.name || t("claude.newClaudeCodeConversation"),
      status: approvals.length
        ? "waiting"
        : busy || bridgeWorking || preparing
          ? "running"
          : error
            ? "error"
            : ready
              ? "idle"
              : "connecting",
      hasDraft: Boolean(input.trim() || files.length || attachments.loading),
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
  const approval = approvals[0];
  const questions = Array.isArray(approval?.request?.input?.questions)
    ? (approval.request.input.questions as Array<{
        question: string;
        options?: Array<{ label: string; description?: string }>;
      }>)
    : [];
  const respond = async (allow: boolean) => {
    if (!approval || !sessionId) return;
    try {
      await backend.respondPermission(sessionId, approval.request_id ?? "", allow, answers);
      setApprovals((current) => current.filter((a) => a.request_id !== approval.request_id));
      setAnswers({});
    } catch (cause) {
      setError(String(cause));
    }
  };
  const currentModel = models.find((entry) => entry.value === model);
  const currentSession = sessions.find((s) => s.id === sessionId);
  const efforts = currentModel?.supportedEffortLevels || ["low", "medium", "high"];
  return (
    <div
      data-chat-panel="claude"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="min-w-0 truncate text-sm font-medium">
          {sessions.find((s) => s.id === sessionId)?.name || "Claude Code"}
        </div>
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          {backend.shareSession && currentSession && sessionId && (
            <ShareToggle
              mine={currentSession.mine}
              shared={currentSession.shared}
              ownerName={currentSession.ownerName}
              onError={setError}
              onShare={async (shared) => {
                await backend.shareSession?.(sessionId, shared);
                setSessions((current) =>
                  current.map((entry) => (entry.id === sessionId ? { ...entry, shared } : entry)),
                );
              }}
            />
          )}
          <button
            type="button"
            onClick={() => {
              if (lifecycle.onShowHistory) lifecycle.onShowHistory();
              else {
                setHistory(!history);
                void refresh();
              }
            }}
            className="border border-border px-2 py-1 text-xs"
          >
            {t("claude.history")}
          </button>
          <button
            type="button"
            title={t("claude.newConversation")}
            aria-label={t("claude.newClaudeConversation")}
            disabled={!lifecycle.onNewConversation && (busy || preparing)}
            onClick={() => {
              if (lifecycle.onNewConversation) {
                lifecycle.onNewConversation();
                return;
              }
              remember(null);
              setMessages({ items: [], messageId: "" });
              setHistory(false);
              setError("");
            }}
            className="border border-border p-1"
          >
            <PlusIcon className="size-4" />
          </button>
        </div>
      </header>
      {bridge.view}
      {history && (
        <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border p-2">
          {sessions.map((session) => (
            <div key={session.id} className="group flex min-w-0 items-center">
              <button
                type="button"
                disabled={!lifecycle.onOpenConversation && (busy || preparing)}
                onClick={() => {
                  if (lifecycle.onOpenConversation)
                    lifecycle.onOpenConversation(session.id, session.name);
                  else void openSession(session.id).catch((cause) => setError(String(cause)));
                  setHistory(false);
                }}
                title={session.name}
                className="min-w-0 flex-1 truncate p-2 text-left text-xs hover:bg-accent-hover group-has-[input]:hidden"
              >
                {session.name}
              </button>
              <RenameChat
                name={session.name}
                onRename={async (name) => {
                  await backend.renameSession(directory ?? "", session.id, name);
                  await refresh();
                }}
              />
            </div>
          ))}
          {!sessions.length && (
            <p className="p-2 text-xs text-muted">{t("claude.noClaudeCodeConversationsYet")}</p>
          )}
        </div>
      )}
      <div
        ref={historyRef}
        onScroll={() => {
          const el = historyRef.current;
          if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        data-chat-history="claude"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4"
      >
        {idleHistory.sleeping && (
          <p role="status">
            {idleHistory.error || t("claude.restoringTheConversation")}
            {idleHistory.error && (
              <button type="button" onClick={idleHistory.retry}>
                {t("claude.retry")}
              </button>
            )}
          </p>
        )}
        {!idleHistory.sleeping && !messages.items.length && (
          <div className="space-y-2 py-6 text-sm text-muted">
            <p className="font-medium text-foreground">
              {!ready
                ? t("claude.connectingToClaudeCode")
                : backend.kind === "shared"
                  ? t("claude.runsOnTheLabRunnerAndEditsTheSharedProject")
                  : t("claude.usesClaudeCodeOnThisComputer")}
            </p>
            {backend.kind !== "shared" && (
              <p>{t("claude.usesYourLocalSignInAndModelSettingsItCan")}</p>
            )}
          </div>
        )}
        <ChatHistoryItems items={messages.items} onFileClick={onFileClick} directory={directory} />
        {busy && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted">
            <span className="size-2 bg-accent motion-safe:animate-pulse" />
            {approval ? t("claude.waitingForYourReply") : t("claude.claudeCodeIsWorking")}
          </p>
        )}
      </div>
      {approval && (
        <div className="max-h-[30%] shrink-0 overflow-y-auto border-t border-border bg-accent-hover p-3 text-xs">
          <p className="font-medium">
            {questions.length
              ? t("claude.claudeCodeNeedsMoreFromYou")
              : t("claude.approvalRequestedTool", {
                  tool: approval.request?.tool_name || t("claude.tool"),
                })}
          </p>
          {questions.length ? (
            questions.map((q) => (
              <label key={q.question} className="mt-2 block">
                {q.question}
                <input
                  value={answers[q.question] || ""}
                  onChange={(e) =>
                    setAnswers((current) => ({ ...current, [q.question]: e.target.value }))
                  }
                  className="mt-1 w-full border border-border bg-background p-2"
                />
                {q.options?.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() =>
                      setAnswers((current) => ({ ...current, [q.question]: option.label }))
                    }
                    className="mr-1 mt-1 border border-border px-2 py-1"
                  >
                    {option.label}
                  </button>
                ))}
              </label>
            ))
          ) : (
            <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(approval.request?.input, null, 2)}
            </pre>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void respond(true)}
              className="border border-foreground bg-foreground px-2 py-1 text-background"
            >
              {questions.length ? t("claude.submit") : t("claude.allowOnce")}
            </button>
            <button
              type="button"
              onClick={() => void respond(false)}
              className="border border-border px-2 py-1"
            >
              {t("claude.deny")}
            </button>
          </div>
        </div>
      )}
      <SharedRunnerNotice notice={notice} busyName={projectBusy} />
      {error && (
        <div
          role="alert"
          className="max-h-28 shrink-0 overflow-y-auto border-t border-border px-3 py-2 text-xs text-red-600"
        >
          {error}
          {!ready && (
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
              className="ml-2 underline"
            >
              {t("claude.reconnect")}
            </button>
          )}
        </div>
      )}
      <ResizableComposer backend="claude">
        <fieldset
          ref={attachments.areaRef}
          aria-label={t("claude.messageAndAttachments")}
          onDragOver={(e) => e.preventDefault()}
          onDrop={attachments.onDrop}
          className="writer-composer-card"
        >
          <DeliveryControls
            mode={deliveryMode}
            onModeChange={setDeliveryMode}
            busy={busy}
            outbox={outbox}
          />
          {editorSelection && (
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate">
                {t("agentsCommon.quotingPathRanges", {
                  path: editorSelection.path,
                  ranges: editorSelection.ranges
                    .map(selectionRangeLabel)
                    .join(t("agentsCommon.listSeparator")),
                })}
              </span>
              <button type="button" onClick={onClearSelection}>
                {t("claude.remove")}
              </button>
            </div>
          )}
          <AttachmentStrip
            files={files}
            disabled={preparing}
            onRemove={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
          />
          {attachments.error && (
            <p role="alert" className="px-3 text-xs text-red-600">
              {attachments.error}
            </p>
          )}
          <GrowingTextarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={attachments.onPaste}
            onCompositionStart={() => {
              if (compositionTimer.current) clearTimeout(compositionTimer.current);
              composing.current = true;
            }}
            onCompositionEnd={() => {
              compositionTimer.current = setTimeout(() => {
                composing.current = false;
              }, 0);
            }}
            onKeyDown={(e) => {
              if (
                shouldSendOnEnter(
                  {
                    key: e.key,
                    shiftKey: e.shiftKey,
                    isComposing: e.nativeEvent.isComposing,
                    keyCode: e.nativeEvent.keyCode,
                  },
                  composing.current,
                )
              ) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={3}
            aria-label={t("claude.messageToClaudeCode")}
            placeholder={t("claude.askClaudeCodeToFindReferencesOrEditTheSe")}
            className="writer-composer-input"
          />
          <div className="writer-composer-toolbar">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap text-xs">
              <select
                aria-label={t("claude.claudeCodePermissions")}
                value={permission}
                title={t(
                  PERMISSIONS.find((option) => option.value === permission)?.description ??
                    "claude.asksEachTimeAPermissionIsNeeded",
                )}
                disabled={!ready || busy || preparing || bridgeWorking}
                onChange={(e) => {
                  const value = e.target.value;
                  if (!isPermissionMode(value)) return;
                  setPermission(value);
                  if (directory)
                    localStorage.setItem(`lmms-writer-claude-permission:${directory}`, value);
                }}
                className="max-w-28 shrink-0 border border-border bg-background px-1.5 py-1"
              >
                {PERMISSIONS.filter((option) => allowed.includes(option.value)).map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.label)}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("claude.claudeCodeModel")}
                value={model}
                disabled={busy}
                onChange={(e) => {
                  setModel(e.target.value);
                  const next = models.find(
                    (m) => m.value === e.target.value,
                  )?.supportedEffortLevels;
                  if (next && !next.includes(effort)) setEffort(next[0] || "");
                }}
                className="min-w-20 max-w-40 flex-1 truncate border border-border bg-background px-1.5 py-1"
              >
                {!models.length && (
                  <option value="default">
                    {t(backend.kind === "shared" ? "claude.runnerDefault" : "claude.localDefault")}
                  </option>
                )}
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.value === "default"
                      ? t(
                          backend.kind === "shared"
                            ? "claude.runnerDefault"
                            : "claude.localDefault",
                        )
                      : `${m.value} · ${m.displayName}`}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("claude.claudeCodeEffort")}
                value={effort}
                disabled={busy}
                onChange={(e) => setEffort(e.target.value)}
                className="w-20 shrink-0 border border-border bg-background px-1.5 py-1"
              >
                {efforts.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </div>
            <input
              ref={attachments.pickerRef}
              type="file"
              accept={undefined}
              multiple
              className="hidden"
              onChange={(e) => {
                void attachments.addFiles(Array.from(e.target.files || []));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              aria-label={t("claude.addAttachment")}
              title={t("claude.addAttachment")}
              disabled={preparing || attachments.loading}
              onClick={() => void attachments.choose()}
              className="flex size-8 shrink-0 items-center justify-center border border-border"
            >
              <PaperclipIcon className="size-4" />
            </button>
            {busy && (
              <button
                type="button"
                aria-label={t("claude.stopClaudeCode")}
                onClick={() =>
                  void outbox
                    .pause(t("claude.taskStoppedTheQueueIsPaused"))
                    .catch(() => {})
                    .then(() => sessionId && backend.stop(sessionId))
                    .catch((cause) => setError(String(cause)))
                }
                className="flex size-8 shrink-0 items-center justify-center border border-border"
              >
                <StopIcon className="size-4" />
              </button>
            )}
            <button
              type="button"
              aria-label={
                busy
                  ? deliveryMode === "queue"
                    ? t("claude.addToTheClaudeCodeQueue")
                    : t("claude.steerClaudeCodeNow")
                  : t("claude.sendToClaudeCode")
              }
              disabled={
                !ready || preparing || attachments.loading || (!input.trim() && !files.length)
              }
              onClick={() => void send(input)}
              className="flex size-8 shrink-0 items-center justify-center bg-foreground text-background disabled:opacity-40"
            >
              <ArrowUpIcon className="size-4" />
            </button>
          </div>
        </fieldset>
      </ResizableComposer>
    </div>
  );
}
