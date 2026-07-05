"use client";

import { useAutoAnimate } from "@formkit/auto-animate/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ToolPart } from "@/lib/opencode/types";
import { useOpenCode } from "@/lib/opencode/use-opencode";
import { ChevronIcon, PlusIcon } from "./icons";
import { InputArea } from "./input-area";
import { MessageList } from "./message-list";
import { OnboardingState } from "./onboarding";
import { EmptyState, SessionList } from "./session-list";
import { CollapsibleTasksBar, parseTasks } from "./tasks-display";
import type { Props } from "./types";

export const OpenCodePanel = memo(function OpenCodePanel({
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
}: Props) {
  const opencode = useOpenCode({ baseUrl, directory, autoConnect });
  const [input, setInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<
    { url: string; mime: string; filename: string }[]
  >([]);
  const [showSessionList, setShowSessionList] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastSessionIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pendingMessageSentRef = useRef(false);
  const [panelParent] = useAutoAnimate({ duration: 200 });

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
  }, [opencode]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  const updateShouldAutoScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 120;
  }, []);

  // Keep the stream pinned to the bottom unless the user intentionally scrolls up.
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
  });

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      if (shouldAutoScrollRef.current) {
        scrollToBottom("smooth");
      }
    });
    observer.observe(container);
    if (scrollContentRef.current) observer.observe(scrollContentRef.current);

    return () => observer.disconnect();
  }, [scrollToBottom]);

  // Handle pending message from external source
  useEffect(() => {
    const handlePendingMessage = async () => {
      if (!pendingMessage || pendingMessageSentRef.current || !opencode.connected) {
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
          console.error("[OpenCode] Error sending pending message:", error);
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
    const session = await opencode.createSession();
    if (session) {
      await opencode.selectSession(session.id);
      setShowSessionList(false);
    }
  }, [opencode]);

  const _handleSelectSession = useCallback(
    async (sessionId: string) => {
      await opencode.selectSession(sessionId);
      setShowSessionList(false);
    },
    [opencode],
  );

  const handleSend = useCallback(async () => {
    const content = input.trim();
    if (!content && attachedFiles.length === 0) return;
    const filesToSend = [...attachedFiles];
    shouldAutoScrollRef.current = true;
    setInput("");
    setAttachedFiles([]);
    await opencode.sendMessage(content, filesToSend.length > 0 ? filesToSend : undefined);
    scrollToBottom("smooth");
  }, [input, attachedFiles, opencode, scrollToBottom]);

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
    [opencode],
  );

  const handleAbort = useCallback(async () => {
    await opencode.abort();
  }, [opencode]);

  const isWorking =
    opencode.status.type === "running" ||
    opencode.status.type === "busy" ||
    opencode.status.type === "retry";

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

  if (!opencode.currentSessionId || showSessionList) {
    return (
      <div className={`flex h-full flex-col ${className}`}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <h2 className="text-xs font-mono font-medium uppercase tracking-wider">Chats</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleNewSession}
              className="text-[10px] font-mono px-2 py-1 border border-border hover:border-accent transition-colors"
            >
              + New
            </button>
            {opencode.currentSessionId && (
              <button
                type="button"
                onClick={() => setShowSessionList(false)}
                className="text-[10px] font-mono text-muted hover:text-foreground transition-colors"
              >
                Back
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <SessionList
            sessions={opencode.sessions}
            currentSessionId={opencode.currentSessionId}
            onSelect={(id) => {
              opencode.selectSession(id);
              setShowSessionList(false);
            }}
            onDelete={opencode.deleteSession}
            onNewSession={async () => {
              const s = await opencode.createSession();
              if (s) setShowSessionList(false);
            }}
          />
        </div>
      </div>
    );
  }

  const currentSession = opencode.sessions.find((s) => s.id === opencode.currentSessionId);

  return (
    <div ref={panelParent} className={`flex h-full flex-col bg-accent-hover/50 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-background px-3 py-2">
        <div className="flex items-center gap-2 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowSessionList(true)}
            className="flex-shrink-0 text-muted hover:text-foreground transition-colors"
          >
            <ChevronIcon className="size-4 rotate-90" />
          </button>
          <div className="flex flex-col min-w-0">
            <h2 className="text-xs font-medium truncate">{currentSession?.title || "New Chat"}</h2>
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
            title="New Chat"
          >
            <PlusIcon className="size-5" />
          </button>
        </div>
      </div>

      {/* Collapsible tasks bar */}
      {latestTasks && <CollapsibleTasksBar tasks={latestTasks} />}

      {/* Content Area */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div className="absolute inset-0 flex flex-col">
          <div
            ref={scrollContainerRef}
            onScroll={updateShouldAutoScroll}
            className="flex-1 overflow-y-auto px-4 py-4"
          >
            <div ref={scrollContentRef}>
              {opencode.messages.length === 0 ? (
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

          <div className="border-t border-border bg-background p-3">
            <InputArea
              input={input}
              setInput={setInput}
              attachedFiles={attachedFiles}
              setAttachedFiles={setAttachedFiles}
              onSend={handleSend}
              onAbort={handleAbort}
              isWorking={isWorking}
              agents={opencode.agents}
              providers={opencode.providers}
              selectedAgent={opencode.selectedAgent}
              selectedModel={opencode.selectedModel}
              onSelectAgent={opencode.setSelectedAgent}
              onSelectModel={opencode.setSelectedModel}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
