"use client";
import { ArrowUpIcon, PaperclipIcon, PlusIcon, StopIcon } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationBridge } from "@/components/bridge/conversation-bridge";
import { AttachmentStrip } from "@/components/chat/attachment-strip";
import { DeliveryControls, type DeliveryMode } from "@/components/chat/delivery-controls";
import { GrowingTextarea } from "@/components/chat/growing-textarea";
import { ChatHistoryItems } from "@/components/chat/history-items";
import { RenameChat } from "@/components/chat/rename-chat";
import { ResizableComposer } from "@/components/ui/panel-height";
import { useConversationBridge } from "@/lib/bridge/use-conversation-bridge";
import { useComposerDraft } from "@/lib/chat/composer-drafts";
import { prepareChatFiles } from "@/lib/chat/files";
import { mergeById } from "@/lib/chat/idle-transcript";
import type { ChatImageFile } from "@/lib/chat/images";
import type { ChatDraft, ChatOutbox } from "@/lib/chat/outbox";
import { useChatAttachments } from "@/lib/chat/use-chat-attachments";
import { useChatOutbox } from "@/lib/chat/use-chat-outbox";
import { useIdleTranscript } from "@/lib/chat/use-idle-transcript";
import { type ClaudeEvent, type ClaudeMessages, reduceClaudeEvent } from "@/lib/claude/events";
import { shouldSendOnEnter } from "@/lib/codex/composer-keys";
import {
  type EditorSelectionContext,
  selectionRangeLabel,
  withEditorSelection,
} from "@/lib/editor/selection-context";
import type { HarnessLifecycle } from "@/lib/harness/types";
import { usePanelLifecycle } from "@/lib/harness/use-panel-lifecycle";

type Session = { id: string; name: string; directory: string; updatedAt: number };
type Model = { value: string; displayName: string; supportedEffortLevels?: string[] };
const PERMISSIONS = [
  { value: "default", label: "请求批准", description: "需要权限时逐次询问" },
  { value: "acceptEdits", label: "自动编辑", description: "自动批准文件编辑；部分命令仍需审批" },
  {
    value: "bypassPermissions",
    label: "无需审批",
    description: "命令和文件修改无需逐次审批；Claude 的强制规则和用户问题仍保留",
  },
  { value: "plan", label: "仅规划", description: "先分析和规划，修改仍需审批" },
] as const;
type PermissionMode = (typeof PERMISSIONS)[number]["value"];
const isPermissionMode = (value: string | null): value is PermissionMode =>
  PERMISSIONS.some((option) => option.value === value);
type Props = HarnessLifecycle & {
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
  const initialSession = useRef(lifecycle.initialSessionId);
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
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
  const bridge = useConversationBridge(
    "claude",
    sessionId,
    directory,
    sessions.find((s) => s.id === sessionId)?.name || "Claude Code",
    busy || preparing,
    { model, effort, permissionMode: permission },
  );
  const bridgeWorking = bridge.snapshot.conversations.some(
    (s) => s.id === bridge.fullId && Boolean(s.activeJob),
  );
  const refresh = useCallback(async () => {
    if (directory) setSessions(await invoke<Session[]>("claude_list_sessions", { cwd: directory }));
  }, [directory]);
  const openSession = useCallback(
    async (id: string) => {
      const saved = await invoke<{
        session: Session;
        events: ClaudeEvent[];
        busy: boolean;
        pending: ClaudeEvent[];
      }>("claude_read_session", { cwd: directory, sessionId: id });
      remember(id);
      pinned.current = true;
      setMessages(saved.events.reduce(reduceClaudeEvent, { items: [], messageId: "" }));
      setBusy(saved.busy);
      setApprovals(saved.pending);
      setHistory(false);
      setError("");
    },
    [directory, remember],
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
      unlisten = await listen<{ directory: string; sessionId: string; event: ClaudeEvent }>(
        "claude://event",
        ({ payload }) => {
          if (
            disposed ||
            payload.directory !== directory ||
            payload.sessionId !== sessionRef.current
          )
            return;
          const event = payload.event;
          setMessages((current) => reduceClaudeEvent(current, event));
          if (event.type === "control_request")
            setApprovals((current) => [
              ...current.filter((a) => a.request_id !== event.request_id),
              event,
            ]);
          if (event.type === "control_cancel_request")
            setApprovals((current) => current.filter((a) => a.request_id !== event.request_id));
          if (event.type === "writer_error") {
            setError(event.error || "Claude Code 执行失败");
            if (outboxRef.current?.state.items.length)
              void outboxRef.current.pause("执行失败，队列已暂停。");
          }
          if (event.type === "result" && event.is_error) {
            setError(event.errors?.join("\n") || event.result || "Claude Code 执行失败");
            if (outboxRef.current?.state.items.length)
              void outboxRef.current.pause("执行失败，队列已暂停。");
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
        },
      );
      if (disposed) {
        unlisten?.();
        return;
      }
      const [catalog] = await Promise.all([
        invoke<{ models: Model[] }>("claude_initialize", { cwd: directory }),
        refresh(),
      ]);
      if (disposed) return;
      setModels(catalog.models || []);
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
          if (!disposed) setError(`无法恢复这个 Claude Code 对话，可重试：${String(cause)}`);
          return;
        }
      }
      if (!disposed) setReady(true);
    })().catch((cause) => {
      if (!disposed) setError(String(cause));
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [directory, retry, openSession, remember, refresh]);
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
      if (!ready || sending.current || !directory) throw new Error("连接或发送尚未就绪。");
      if (!steer && (busy || bridgeWorking)) throw new Error("当前任务仍在执行。");
      const expectedSession = sessionRef.current;
      sending.current = true;
      setPreparing(true);
      setError("");
      try {
        await onBeforeSend(draft.selection);
        const payload = await prepareChatFiles(directory, draft.raw, draft.files);
        if (sessionRef.current !== expectedSession) throw new Error("对话已切换，消息没有发送。");
        let id = expectedSession;
        if (!id) {
          if (steer) throw new Error("没有正在执行的对话。");
          const session = await invoke<Session>("claude_create_session", { cwd: directory });
          id = session.id;
          remember(id);
        }
        await bridge.register(id);
        pinned.current = true;
        if (steer)
          await invoke("claude_steer_turn", {
            cwd: directory,
            sessionId: id,
            text: withEditorSelection(payload.text, draft.selection),
            images: payload.images.map((file) => file.url),
          });
        else {
          setBusy(true);
          await invoke("claude_start_turn", {
            cwd: directory,
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
      title: sessions.find((s) => s.id === sessionId)?.name || "新 Claude Code 对话",
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
      await invoke("claude_respond_permission", {
        sessionId,
        requestId: approval.request_id,
        allow,
        answers,
      });
      setApprovals((current) => current.filter((a) => a.request_id !== approval.request_id));
      setAnswers({});
    } catch (cause) {
      setError(String(cause));
    }
  };
  const currentModel = models.find((entry) => entry.value === model);
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
        <div className="flex shrink-0 gap-1">
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
            历史
          </button>
          <button
            type="button"
            title="新对话"
            aria-label="新建 Claude 对话"
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
      <ConversationBridge bridge={bridge} />
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
                  await invoke("claude_rename_session", {
                    cwd: directory,
                    sessionId: session.id,
                    name,
                  });
                  await refresh();
                }}
              />
            </div>
          ))}
          {!sessions.length && <p className="p-2 text-xs text-muted">还没有 Claude Code 对话。</p>}
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
            {idleHistory.error || "正在恢复对话历史…"}
            {idleHistory.error && (
              <button type="button" onClick={idleHistory.retry}>
                重试
              </button>
            )}
          </p>
        )}
        {!idleHistory.sleeping && !messages.items.length && (
          <div className="space-y-2 py-6 text-sm text-muted">
            <p className="font-medium text-foreground">
              {ready ? "使用本机 Claude Code" : "正在连接 Claude Code…"}
            </p>
            <p>沿用本机登录与模型配置，可检索资料、修改论文、读取图片；选中的正文会随消息附上。</p>
          </div>
        )}
        <ChatHistoryItems items={messages.items} onFileClick={onFileClick} directory={directory} />
        {busy && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted">
            <span className="size-2 bg-accent motion-safe:animate-pulse" />
            {approval ? "等待你的回复" : "Claude Code 正在执行…"}
          </p>
        )}
      </div>
      {approval && (
        <div className="max-h-[30%] shrink-0 overflow-y-auto border-t border-border bg-accent-hover p-3 text-xs">
          <p className="font-medium">
            {questions.length
              ? "Claude Code 需要你的补充"
              : `请求批准：${approval.request?.tool_name || "工具"}`}
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
              {questions.length ? "提交" : "仅允许这次"}
            </button>
            <button
              type="button"
              onClick={() => void respond(false)}
              className="border border-border px-2 py-1"
            >
              拒绝
            </button>
          </div>
        </div>
      )}
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
              重新连接
            </button>
          )}
        </div>
      )}
      <ResizableComposer backend="claude">
        <fieldset
          ref={attachments.areaRef}
          aria-label="聊天输入与附件"
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
                已引用 {editorSelection.path} ·{" "}
                {editorSelection.ranges.map(selectionRangeLabel).join("、")}
              </span>
              <button type="button" onClick={onClearSelection}>
                移除
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
            aria-label="发送给 Claude Code 的消息"
            placeholder="让 Claude Code 查找文献或修改选中内容…"
            className="writer-composer-input"
          />
          <div className="writer-composer-toolbar">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap text-xs">
              <select
                aria-label="Claude Code 权限"
                value={permission}
                title={PERMISSIONS.find((option) => option.value === permission)?.description}
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
                {PERMISSIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Claude Code 模型"
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
                {!models.length && <option value="default">本机默认</option>}
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.value === "default" ? "本机默认" : `${m.value} · ${m.displayName}`}
                  </option>
                ))}
              </select>
              <select
                aria-label="Claude Code 推理强度"
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
              aria-label="添加附件"
              title="添加附件"
              disabled={preparing || attachments.loading}
              onClick={() => void attachments.choose()}
              className="flex size-8 shrink-0 items-center justify-center border border-border"
            >
              <PaperclipIcon className="size-4" />
            </button>
            {busy && (
              <button
                type="button"
                aria-label="停止 Claude Code"
                onClick={() =>
                  void outbox
                    .pause("已停止任务，队列已暂停。")
                    .catch(() => {})
                    .then(() => invoke("claude_stop", { sessionId }))
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
                    ? "加入 Claude Code 队列"
                    : "立即指导 Claude Code"
                  : "发送给 Claude Code"
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
