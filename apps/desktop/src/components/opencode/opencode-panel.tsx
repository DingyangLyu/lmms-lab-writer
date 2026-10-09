"use client";

import type { ChatDraft, ChatImageFile, ChatOutbox } from "@lmms-lab/workbench/agents";
import {
  DeliveryControls,
  type DeliveryMode,
  prepareChatFiles,
  useChatOutbox,
  useComposerDraft,
  useIdleTranscript,
  usePanelLifecycle,
  withEditorSelection,
} from "@lmms-lab/workbench/agents";
import { listen } from "@tauri-apps/api/event";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationBridge } from "@/components/bridge/conversation-bridge";
import { ResizableComposer } from "@/components/ui/panel-height";
import { useConversationBridge } from "@/lib/bridge/use-conversation-bridge";
import { useI18n } from "@/lib/i18n";
import { getOpenCodeErrorMessage } from "@/lib/opencode/client";
import type { ToolPart } from "@/lib/opencode/types";
import { useOpenCode } from "@/lib/opencode/use-opencode";
import { PlusIcon } from "./icons";
import { InputArea } from "./input-area";
import { MessageList } from "./message-list";
import { OnboardingState } from "./onboarding";
import { EmptyState, SessionList } from "./session-list";
import { CollapsibleTasksBar, parseTasks } from "./tasks-display";
import type { Props } from "./types";

export const OpenCodePanel = memo(function OpenCodePanel({
  active = true,
  onWorkingChange,
  className = "",
  baseUrl,
  directory,
  autoConnect = false,
  daemonStatus,
  onRestartOpenCode,
  onMaxReconnectFailed,
  onFileClick,
  pendingMessage,
  onPendingMessageSent,
  editorSelection = null,
  onClearSelection,
  onSelectionSent,
  onBeforeSend,
  ...lifecycle
}: Props) {
  const { t } = useI18n();
  const opencode = useOpenCode({
    baseUrl,
    directory,
    autoConnect,
    initialSessionId: lifecycle.initialSessionId,
  });
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [input, setInput] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("steer");
  const outboxRef = useRef<ChatOutbox | null>(null);
  const registerRef = useRef<((id: string) => Promise<void>) | null>(null);
  const sessionRef = useRef(opencode.currentSessionId);
  sessionRef.current = opencode.currentSessionId;
  useEffect(() => {
    if (opencode.error && outboxRef.current?.state.items.length)
      void outboxRef.current.pause(opencode.error);
  }, [opencode.error]);
  const [preparing, setPreparing] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const cancelSendRef = useRef(false);
  const [attachedFiles, setAttachedFiles] = useState<ChatImageFile[]>([]);
  useComposerDraft(
    directory,
    lifecycle.instanceId,
    input,
    setInput,
    attachedFiles,
    setAttachedFiles,
  );
  const [showSessionList, setShowSessionList] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastSessionIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pendingMessageSentRef = useRef(false);

  useEffect(() => {
    if (pendingMessage) {
      pendingMessageSentRef.current = false;
    }
  }, [pendingMessage]);

  // Extract latest tasks from message history
  const latestTasks = useMemo(() => {
    // Scan messages in reverse to find the last updated task list
    for (let i = opencode.messages.length - 1; i >= 0; i--) {
      const msg = opencode.messages[i];
      if (!msg) continue;
      if (msg.role !== "assistant") continue;

      const msgParts = opencode.getPartsForMessage(msg.id);
      for (let j = msgParts.length - 1; j >= 0; j--) {
        const p = msgParts[j];
        if (!p) continue;
        if (p.type === "tool") {
          const tp = p as ToolPart;
          const isTaskTool = [
            "todowrite",
            "todocreate",
            "todolist",
            "todoread",
            "todoupdate",
          ].includes(tp.tool.toLowerCase());
          if (isTaskTool) {
            const output = (tp.state as { output?: string }).output;
            if (output) {
              try {
                const parsed = JSON.parse(output);
                const tasks = parseTasks(parsed);
                if (tasks) return tasks;
              } catch {
                /* ignore parse errors */
              }
            }
            if (tp.state.input) {
              const tasks = parseTasks(tp.state.input);
              if (tasks) return tasks;
            }
          }
        }
      }
    }
    return null;
  }, [opencode.messages, opencode.getPartsForMessage]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (active) messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
    },
    [active],
  );

  const updateShouldAutoScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 120;
  }, []);

  // Keep the stream pinned to the bottom unless the user intentionally scrolls up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: New streamed parts trigger scrolling; composer text must not.
  useEffect(() => {
    if (lastSessionIdRef.current !== opencode.currentSessionId) {
      lastSessionIdRef.current = opencode.currentSessionId;
      shouldAutoScrollRef.current = true;
      scrollToBottom("auto");
      return;
    }

    if (!shouldAutoScrollRef.current) return;

    const frame = requestAnimationFrame(() => {
      scrollToBottom("smooth");
    });
    return () => cancelAnimationFrame(frame);
  }, [opencode.currentSessionId, opencode.messages, opencode.getPartsForMessage, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || showSessionList || !opencode.currentSessionId) return;

    const observer = new ResizeObserver(() => {
      if (shouldAutoScrollRef.current) {
        scrollToBottom("smooth");
      }
    });
    observer.observe(container);
    if (scrollContentRef.current) observer.observe(scrollContentRef.current);

    return () => observer.disconnect();
  }, [scrollToBottom, showSessionList, opencode.currentSessionId]);

  // Handle pending message from external source
  useEffect(() => {
    const handlePendingMessage = async () => {
      if (
        !pendingMessage ||
        pendingMessageSentRef.current ||
        !opencode.connected ||
        ["running", "busy", "retry"].includes(opencode.status.type)
      ) {
        return;
      }

      // Wait for model to be selected
      if (!opencode.selectedModel && opencode.providers.length === 0) {
        return;
      }

      // If no session exists, create one first
      let sessionId = opencode.currentSessionId;
      if (!sessionId) {
        const newSession = await opencode.createSession();
        if (!newSession) {
          onPendingMessageSent?.();
          return;
        }
        sessionId = newSession.id;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Now send the message
      if (sessionId) {
        pendingMessageSentRef.current = true;
        try {
          await opencode.sendMessage(pendingMessage);
          onPendingMessageSent?.();
        } catch (error) {
          console.error(
            `[OpenCode] Error sending pending message: ${getOpenCodeErrorMessage(error, "Unknown error")}`,
          );
        }
      }
    };

    handlePendingMessage();
  }, [pendingMessage, opencode, onPendingMessageSent]);

  useEffect(() => {
    if (opencode.maxReconnectFailed && onMaxReconnectFailed) {
      onMaxReconnectFailed();
    }
  }, [opencode.maxReconnectFailed, onMaxReconnectFailed]);

  const handleConnect = useCallback(() => {
    opencode.connect();
  }, [opencode]);

  const handleNewSession = useCallback(async () => {
    if (lifecycle.onNewConversation) {
      lifecycle.onNewConversation();
      return;
    }
    const session = await opencode.createSession();
    if (session) {
      await opencode.selectSession(session.id);
      setShowSessionList(false);
    }
  }, [opencode, lifecycle.onNewConversation]);

  const _handleSelectSession = useCallback(
    async (sessionId: string) => {
      await opencode.selectSession(sessionId);
      setShowSessionList(false);
    },
    [opencode],
  );

  const transmit = useCallback(
    async (draft: ChatDraft, steer = false) => {
      if (!opencode.ready) throw new Error(t("opencode.loadingTheConnectionOrHistorySendAgainIn"));
      if (sendingRef.current) throw new Error(t("opencode.thePreviousMessageIsStillSending"));
      const expectedSession = opencode.currentSessionId;
      sendingRef.current = true;
      cancelSendRef.current = false;
      setPreparing(true);
      setSendError(null);
      try {
        await onBeforeSend?.(draft.selection);
        const payload = await prepareChatFiles(directory, draft.raw.trim(), draft.files);
        if (cancelSendRef.current || expectedSession !== sessionRef.current)
          throw new Error(t("opencode.sendingWasCancelledOrTheConversationChan"));
        if (!expectedSession) {
          const created = await opencode.createSession();
          if (!created) throw new Error(t("opencode.couldNotStartAConversationYourTextIsKept"));
          await registerRef.current?.(created.id);
        }
        shouldAutoScrollRef.current = true;
        const sent = await opencode.sendMessage(
          withEditorSelection(payload.text, draft.selection),
          payload.images,
          steer,
        );
        if (!sent) throw new Error(t("opencode.opencodeDidNotConfirmTheMessageCheckTheC"));
        scrollToBottom("auto");
      } finally {
        sendingRef.current = false;
        setPreparing(false);
      }
    },
    [opencode, onBeforeSend, scrollToBottom, directory, t],
  );

  const handleAnswer = useCallback(
    async (_questionID: string, answers: string[][]) => {
      // Use the question ID from the SSE question.asked event (que_...), not the tool part ID (prt_...)
      const actualQuestionID = opencode.currentQuestion?.id;
      if (!actualQuestionID) {
        console.warn("[OpenCode] No currentQuestion available, cannot answer");
        return;
      }
      await opencode.answerQuestion(actualQuestionID, answers);
    },
    [opencode.currentQuestion?.id, opencode.answerQuestion],
  );

  const handleAbort = useCallback(async () => {
    cancelSendRef.current = true;
    if (outboxRef.current?.state.items.length)
      await outboxRef.current.pause(t("opencode.taskStoppedTheQueueIsPaused")).catch(() => {});
    await opencode.abort();
  }, [opencode, t]);

  const isWorking =
    opencode.status.type === "running" ||
    opencode.status.type === "busy" ||
    opencode.status.type === "retry";

  const bridge = useConversationBridge(
    "opencode",
    opencode.currentSessionId,
    directory,
    opencode.currentSession?.title || "OpenCode",
    isWorking || preparing,
    {
      model: opencode.selectedModel
        ? { providerID: opencode.selectedModel.providerId, modelID: opencode.selectedModel.modelId }
        : null,
      variant: opencode.selectedModel?.variant,
      agent: opencode.selectedAgent,
    },
  );
  registerRef.current = bridge.register;
  const bridgeWorking = bridge.snapshot.conversations.some(
    (session) => session.id === bridge.fullId && Boolean(session.activeJob),
  );
  const outbox = useChatOutbox({
    scope:
      directory && opencode.currentSessionId
        ? JSON.stringify(["opencode", directory, opencode.currentSessionId])
        : null,
    ready: opencode.ready,
    busy: isWorking || bridgeWorking || preparing,
    completion: opencode.completion,
    deliver: (message) => transmit(message),
  });
  outboxRef.current = outbox;
  const historySnapshot = useMemo(
    () => ({ messages: opencode.messages, parts: opencode.parts }),
    [opencode.messages, opencode.parts],
  );
  const idleHistory = useIdleTranscript({
    scope: `opencode:${directory}:${lifecycle.instanceId}:${opencode.currentSessionId}`,
    active,
    protectedWork:
      !opencode.ready ||
      isWorking ||
      preparing ||
      bridgeWorking ||
      Boolean(opencode.currentQuestion) ||
      Boolean(input.trim()) ||
      attachedFiles.length > 0 ||
      outbox.state.items.length > 0 ||
      Boolean(lifecycle.incoming),
    value: historySnapshot,
    release: opencode.releaseHistory,
    restore: opencode.restoreHistory,
  });

  const handleSend = useCallback(async () => {
    if (sendingRef.current || (!input.trim() && !attachedFiles.length)) return;
    const draft: ChatDraft = { raw: input, files: [...attachedFiles], selection: editorSelection };
    try {
      if ((isWorking || bridgeWorking) && deliveryMode === "queue") await outbox.enqueue(draft);
      else await transmit(draft, isWorking || bridgeWorking);
      setInput((current) => (current === draft.raw ? "" : current));
      setAttachedFiles((current) => current.filter((file) => !draft.files.includes(file)));
      if (draft.selection) onSelectionSent?.(draft.selection);
    } catch (cause) {
      setSendError(getOpenCodeErrorMessage(cause, t("opencode.sendingFailedTheMessageIsKept")));
    }
  }, [
    input,
    attachedFiles,
    editorSelection,
    isWorking,
    bridgeWorking,
    deliveryMode,
    outbox,
    transmit,
    onSelectionSent,
    t,
  ]);
  useEffect(() => {
    onWorkingChange?.(isWorking || preparing || bridgeWorking);
  }, [isWorking, preparing, bridgeWorking, onWorkingChange]);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void listen<{ id: string }>("writer://conversation-updated", ({ payload }) => {
      if (payload.id === bridge.fullId && opencode.currentSessionId)
        void opencode.selectSession(opencode.currentSessionId);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [bridge.fullId, opencode.currentSessionId, opencode.selectSession]);

  usePanelLifecycle(
    lifecycle,
    {
      sessionId: opencode.currentSessionId,
      title: opencode.currentSession?.title || t("opencode.newOpencodeConversation"),
      status: opencode.currentQuestion
        ? "waiting"
        : isWorking || bridgeWorking || preparing
          ? "running"
          : opencode.error || sendError
            ? "error"
            : opencode.ready
              ? "idle"
              : "connecting",
      hasDraft: Boolean(input.trim() || attachedFiles.length || attachmentLoading),
      queued: outbox.state.items.length,
    },
    {
      ready: opencode.ready && Boolean(opencode.selectedModel),
      busy: isWorking || bridgeWorking,
      preparing,
      transmit,
      enqueue: (draft) => outbox.enqueue(draft),
      onError: setSendError,
    },
  );

  // Not connected - show onboarding
  if (!opencode.connected) {
    return (
      <div className={`flex flex-col bg-background min-h-0 ${className}`}>
        <OnboardingState
          connecting={opencode.connecting}
          error={opencode.error}
          onConnect={handleConnect}
          daemonStatus={daemonStatus}
          onRestartOpenCode={onRestartOpenCode}
          hasProject={!!directory}
        />
      </div>
    );
  }

  if (showSessionList) {
    return (
      <div className={`flex h-full flex-col ${className}`}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <h2 className="text-xs font-mono font-medium uppercase tracking-wider">
            {t("opencode.chats")}
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleNewSession}
              className="text-[10px] font-mono px-2 py-1 border border-border hover:border-accent transition-colors"
            >
              {t("opencode.new")}
            </button>
            {opencode.currentSessionId && (
              <button
                type="button"
                onClick={() => setShowSessionList(false)}
                className="text-[10px] font-mono text-muted hover:text-foreground transition-colors"
              >
                {t("opencode.back")}
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sendError && (
            <p role="alert" className="p-2 text-xs text-accent">
              {sendError}
            </p>
          )}
          <SessionList
            sessions={opencode.sessions}
            currentSessionId={opencode.currentSessionId}
            onSelect={(id) => {
              if (lifecycle.onOpenConversation)
                lifecycle.onOpenConversation(id, opencode.sessions.find((s) => s.id === id)?.title);
              else void opencode.selectSession(id);
              setShowSessionList(false);
            }}
            onDelete={async (id) => {
              if (lifecycle.openSessionIds?.includes(id)) {
                setSendError(t("opencode.thisConversationIsOpenInATabFinishItsTas"));
                return;
              }
              await opencode.deleteSession(id);
            }}
            onRename={opencode.renameSession}
            onNewSession={handleNewSession}
          />
        </div>
      </div>
    );
  }

  const currentSession = opencode.sessions.find((s) => s.id === opencode.currentSessionId);

  return (
    <div
      data-chat-panel="opencode"
      className={`flex h-full min-h-0 flex-col overflow-hidden bg-accent-hover/50 ${className}`}
    >
      <ConversationBridge bridge={bridge} />
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-background px-3 py-2">
        <div className="flex items-center gap-2 overflow-hidden">
          <button
            type="button"
            onClick={() => {
              if (lifecycle.onShowHistory) lifecycle.onShowHistory();
              else setShowSessionList(true);
            }}
            className="flex-shrink-0 border border-border px-2 py-1 text-muted hover:text-foreground transition-colors"
            title={t("opencode.openAPastConversation")}
            aria-label={t("opencode.opencodeConversations")}
          >
            <span className="text-xs">{t("opencode.history")}</span>
          </button>
          <div className="flex flex-col min-w-0">
            <h2 className="text-xs font-medium truncate">
              {currentSession?.title || t("opencode.newChat")}
            </h2>
            <div className="flex items-center gap-1.5 text-[10px] text-muted font-mono">
              <span
                className={`inline-block size-1.5 rounded-full transition-colors ${isWorking ? "bg-accent animate-pulse" : "bg-border"}`}
              />
              <span className={isWorking ? "text-accent" : ""}>
                {opencode.status.type === "running"
                  ? "writing"
                  : opencode.status.type === "busy"
                    ? "busy"
                    : "ready"}
              </span>
              {baseUrl && (
                <a
                  href={baseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted/60 hover:text-accent hover:underline cursor-pointer transition-colors"
                >
                  · {baseUrl.replace(/^https?:\/\//, "")}
                </a>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleNewSession}
            className="flex-shrink-0 text-muted-foreground hover:text-muted transition-colors"
            title={t("opencode.newChat")}
          >
            <PlusIcon className="size-5" />
          </button>
        </div>
      </div>

      {/* Collapsible tasks bar */}
      {latestTasks && <CollapsibleTasksBar tasks={latestTasks} />}

      {/* Content Area */}
      <div
        ref={scrollContainerRef}
        onScroll={updateShouldAutoScroll}
        data-chat-history="opencode"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div ref={scrollContentRef}>
          {idleHistory.sleeping ? (
            <p role="status">
              {idleHistory.error || t("opencode.restoringTheConversation")}
              {idleHistory.error && (
                <button type="button" onClick={idleHistory.retry}>
                  {t("opencode.retry")}
                </button>
              )}
            </p>
          ) : opencode.messages.length === 0 ? (
            <EmptyState />
          ) : (
            <MessageList
              messages={opencode.messages}
              getPartsForMessage={opencode.getPartsForMessage}
              onFileClick={onFileClick}
              onAnswer={handleAnswer}
            />
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <ResizableComposer backend="opencode">
        {sendError && (
          <p role="alert" className="mb-2 text-xs text-accent break-words">
            {sendError}
          </p>
        )}
        <InputArea
          directory={directory}
          onAttachmentLoading={setAttachmentLoading}
          active={active}
          input={input}
          setInput={setInput}
          attachedFiles={attachedFiles}
          setAttachedFiles={setAttachedFiles}
          onSend={handleSend}
          onAbort={handleAbort}
          isWorking={isWorking || bridgeWorking}
          isSending={preparing || !opencode.ready}
          deliveryMode={deliveryMode}
          deliveryControls={
            <DeliveryControls
              mode={deliveryMode}
              onModeChange={setDeliveryMode}
              busy={isWorking || bridgeWorking}
              outbox={outbox}
            />
          }
          editorSelection={editorSelection}
          onClearSelection={onClearSelection}
          agents={opencode.agents}
          providers={opencode.providers}
          selectedAgent={opencode.selectedAgent}
          selectedModel={opencode.selectedModel}
          onSelectAgent={opencode.setSelectedAgent}
          onSelectModel={opencode.setSelectedModel}
        />
      </ResizableComposer>
    </div>
  );
});
