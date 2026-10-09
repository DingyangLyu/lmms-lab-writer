/**
 * The browser's end of live AI conversations: one WebSocket per open project to the server's
 * relay (server/agents.ts), and the Codex backend the shared chat panel runs on.
 */
import type { CodexBackend, CodexEvent, CodexPermissionMode } from "@lmms-lab/workbench/agents";
import { CODEX_BUSY_EVENT } from "@lmms-lab/workbench/agents";
import type { AgentBusy, AgentStatus, AgentThread } from "../../shared/agents";
import { i18n } from "../i18n";

type Call = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class AgentLink {
  status: AgentStatus = { online: false, name: null, harnesses: [], permissions: [] };
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
    permissions: () => link.status.permissions as CodexPermissionMode[],
    shareThread: (threadId, shared) => link.request("thread.share", { threadId, shared }),
  };
}
