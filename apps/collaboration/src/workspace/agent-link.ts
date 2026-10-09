/**
 * The browser's end of live AI conversations: one WebSocket per open project to the server's
 * relay (server/agents.ts), and the Codex backend the shared chat panel runs on.
 */
import {
  CLAUDE_SESSIONS_EVENT,
  type ClaudeBackend,
  type ClaudeEvent,
  type ClaudePermissionMode,
  type ClaudeSession,
  type ClaudeSnapshot,
  CODEX_BUSY_EVENT,
  type CodexBackend,
  type CodexEvent,
  type CodexPermissionMode,
  type OpenCodeTransport,
} from "@lmms-lab/workbench/agents";
import {
  type AgentBusy,
  type AgentStatus,
  type AgentThread,
  CHANGES_EVENT,
  CLAUDE_EVENT,
  OPENCODE_EVENT,
  THREADS_EVENT,
} from "../../shared/agents";
import { i18n } from "../i18n";

type Call = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class AgentLink {
  status: AgentStatus = { online: false, name: null, harnesses: [], permissions: {} };
  private statusListeners = new Set<(status: AgentStatus) => void>();
  busy: AgentBusy = null;
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private calls = new Map<string, Call>();
  private listeners = new Set<(event: CodexEvent) => void>();
  private next = 0;
  private closed = false;
  constructor(
    private project: string,
    private me: string,
    private locale: () => string,
  ) {}
  /** Opens the socket if needed; resolves once the server has said what the runner offers. */
  connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.opening ??= new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/projects/${this.project}/agents?locale=${this.locale()}`,
      );
      let ready = false;
      socket.onmessage = (message) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if ("status" in data) {
          this.status = data.status as AgentStatus;
          for (const listener of this.statusListeners) listener(this.status);
          if (!ready) {
            ready = true;
            this.socket = socket;
            this.opening = null;
            resolve();
          }
        } else if ("busy" in data) {
          this.busy = data.busy as AgentBusy;
          this.emit({
            method: CODEX_BUSY_EVENT,
            params: {
              busy: this.busy && {
                thread: this.busy.thread,
                userName: this.busy.userName,
                mine: this.busy.user === this.me,
              },
            },
          });
        } else if ("event" in data) this.emit(data.event as CodexEvent);
        else if (typeof data.id === "string") {
          const call = this.calls.get(data.id);
          if (!call) return;
          this.calls.delete(data.id);
          clearTimeout(call.timer);
          if (typeof data.error === "string") call.reject(new Error(data.error));
          else call.resolve(data.result);
        }
      };
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        this.opening = null;
        for (const call of this.calls.values()) {
          clearTimeout(call.timer);
          call.reject(new Error(i18n.t("agents.disconnected")));
        }
        this.calls.clear();
        this.status = { ...this.status, online: false };
        if (!ready) reject(new Error(i18n.t("agents.disconnected")));
        else if (!this.closed) this.emit({ method: "codex/connectionClosed", params: {} });
      };
    });
    return this.opening;
  }
  async request<T>(method: string, params: Record<string, unknown> = {}, timeout = 70_000) {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw new Error(i18n.t("agents.disconnected"));
    const id = `c${++this.next}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(i18n.t("agents.noAnswer")));
      }, timeout);
      this.calls.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  /** What the runner offers, as it connects and changes. */
  onStatus(listener: (status: AgentStatus) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
  listen(handler: (event: CodexEvent) => void) {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
  close() {
    this.closed = true;
    this.socket?.close();
  }
  private emit(event: CodexEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

/** The Codex panel's backend over the relay: the lab runner's Codex, shared per project. */
export function relayCodexBackend(link: AgentLink): CodexBackend {
  return {
    kind: "shared",
    initialize: async () => {
      await link.request("codex.initialize");
    },
    listModels: () => link.request("codex.models"),
    listThreads: async () => {
      const { data } = await link.request<{ data: AgentThread[] }>("codex.threads");
      return {
        data: data.map((thread) => ({
          id: thread.id,
          name: thread.name,
          mine: thread.mine,
          shared: thread.shared,
          ownerName: thread.ownerName,
          updated: thread.updated,
        })),
      };
    },
    resumeThread: (threadId, permissionMode) =>
      link.request("codex.resume", { threadId, permissionMode }),
    readThread: (threadId) => link.request("codex.read", { threadId }),
    startThread: (_directory, model, permissionMode) =>
      link.request("codex.startThread", { model, permissionMode }),
    // Saving a version and bringing the runner's copy up to date come first.
    startTurn: (turn) => link.request("codex.startTurn", turn, 200_000),
    steerTurn: (turn) => link.request("codex.steer", turn),
    interruptTurn: (threadId, turnId) => link.request("codex.interrupt", { threadId, turnId }),
    renameThread: (threadId, name) => link.request("codex.rename", { threadId, name }),
    respond: (threadId, requestId, response) =>
      link.request("codex.respond", { threadId, requestId, response }),
    pendingRequests: () => link.request("codex.pending"),
    listen: async (handler) => link.listen(handler),
    permissions: () => (link.status.permissions.codex ?? []) as CodexPermissionMode[],
    shareThread: (threadId, shared) => link.request("thread.share", { threadId, shared }),
  };
}

/** The Claude Code panel's backend over the relay: the lab runner's CLI, shared per project. */
export function relayClaudeBackend(link: AgentLink): ClaudeBackend {
  const thread = (event: CodexEvent) => String(event.params?.threadId ?? "");
  return {
    kind: "shared",
    initialize: () => link.request("claude.initialize", {}, 70_000),
    listSessions: () => link.request<ClaudeSession[]>("claude.sessions"),
    createSession: () => link.request<ClaudeSession>("claude.createSession"),
    readSession: (_directory, sessionId) =>
      link.request<ClaudeSnapshot>("claude.read", { threadId: sessionId }),
    renameSession: (_directory, sessionId, name) =>
      link.request("claude.rename", { threadId: sessionId, name }),
    // Saving a version and bringing the runner's copy up to date come first.
    startTurn: ({ sessionId, text, images, options }) =>
      link.request("claude.startTurn", { threadId: sessionId, text, images, options }, 200_000),
    steerTurn: ({ sessionId, text, images }) =>
      link.request("claude.steer", { threadId: sessionId, text, images }),
    respondPermission: (sessionId, requestId, allow, answers) =>
      link.request("claude.respond", { threadId: sessionId, requestId, allow, answers }),
    stop: (sessionId) => link.request("claude.stop", { threadId: sessionId }),
    listen: async (handler) =>
      link.listen((event) => {
        if (event.method === CLAUDE_EVENT)
          handler({
            sessionId: thread(event),
            event: (event.params as { event?: ClaudeEvent } | undefined)?.event ?? { type: "" },
          });
        else if (event.method === THREADS_EVENT)
          handler({ sessionId: "", event: { type: CLAUDE_SESSIONS_EVENT } });
        else if (event.method === CHANGES_EVENT)
          handler({
            sessionId: thread(event),
            event: { type: "writer_changes", results: event.params?.results },
          });
        else if (event.method === CODEX_BUSY_EVENT)
          handler({ sessionId: "", event: { type: "writer_busy", busy: event.params?.busy } });
        else if (event.method === "codex/connectionClosed")
          handler({ sessionId: "", event: { type: "writer_disconnected" } });
      }),
    permissions: () => (link.status.permissions.claude ?? []) as ClaudePermissionMode[],
    shareSession: (sessionId, shared) =>
      link.request("thread.share", { threadId: sessionId, shared }),
  };
}

/** Stands in for the address of `opencode serve`; the relay carries every request. */
export const OPENCODE_RELAY = "http://opencode.relay";
/**
 * OpenCode's client, unchanged, over the relay: its requests become `opencode.fetch` calls
 * and its server-sent events arrive on the same socket.
 */
export function relayOpenCodeTransport(link: AgentLink): OpenCodeTransport {
  return {
    fetch: async (url, init) => {
      const parsed = new URL(url);
      const limit = Number(parsed.searchParams.get("limit")) || undefined;
      const result = await link.request<{ status: number; body: string; type?: string }>(
        "opencode.fetch",
        {
          method: init?.method ?? "GET",
          path: parsed.pathname,
          body: typeof init?.body === "string" ? init.body : undefined,
          limit,
        },
        200_000,
      );
      const empty = result.status === 204 || result.status === 304;
      return new Response(empty ? null : result.body, {
        status: result.status,
        headers: { "content-type": result.type || "application/json" },
      });
    },
    openStream: () => {
      type Stream = ReturnType<OpenCodeTransport["openStream"]>;
      let stop = () => {};
      const stream = {
        onopen: null,
        onmessage: null,
        onerror: null,
        close: () => stop(),
      } as Stream;
      const call = (handler: unknown, event: Event) =>
        typeof handler === "function" && handler.call(stream, event);
      stop = link.listen((event) => {
        if (event.method === OPENCODE_EVENT)
          call(
            stream.onmessage,
            new MessageEvent("message", {
              data: JSON.stringify((event.params as { event?: unknown } | undefined)?.event),
            }),
          );
        else if (event.method === "codex/connectionClosed")
          call(stream.onerror, new Event("error"));
      });
      void link.connect().then(
        () => call(stream.onopen, new Event("open")),
        () => call(stream.onerror, new Event("error")),
      );
      return stream;
    },
  };
}
