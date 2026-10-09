import { mergeById } from "@lmms-lab/workbench/agents";
import { i18n } from "@/lib/i18n";
import { openEventStream } from "./event-stream";
import { appendSearchFallbackHint } from "./search-fallback";
import type { Event, Message, Part, SessionInfo, SessionStatus } from "./types";

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export function getOpenCodeErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || fallback;
}
/** Error name when the event stream gives up reconnecting. */
export const RECONNECT_GAVE_UP = "ReconnectGaveUp";
const MAX_PART_TEXT_CHARS = 160_000;
const boundedText = (text: string) =>
  text.length <= MAX_PART_TEXT_CHARS
    ? text
    : `${i18n.t("msg.tooLongTheMiddleWasReleasedFromMemoryThe")}\n${text.slice(-MAX_PART_TEXT_CHARS)}`;

function isNetworkLoadFailure(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /^(load failed|failed to fetch|networkerror|cancelled)$/i.test(error.message.trim())
  );
}

export type OpenCodeClientOptions = {
  baseUrl: string;
  directory?: string;
  onEvent?: (event: Event) => void;
  getSessionId?: () => string | null;
  onError?: (error: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
};

export type OpenCodeStore = {
  connected: boolean;
  sessions: Map<string, SessionInfo>;
  messages: Map<string, Message[]>;
  parts: Map<string, Part[]>;
  status: Map<string, SessionStatus>;
};

export class OpenCodeClient {
  private static readonly MAX_CACHED_SESSIONS = 8;
  private baseUrl: string;
  private directory?: string;
  private statusRevision = new Map<string, number>();
  private eventSource: ReturnType<typeof openEventStream> | null = null;
  private options: OpenCodeClientOptions;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private abortController: AbortController | null = null;
  private sessionAccess = new Map<string, number>();
  private accessSequence = 0;

  public store: OpenCodeStore = {
    connected: false,
    sessions: new Map(),
    messages: new Map(),
    parts: new Map(),
    status: new Map(),
  };

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.directory = options.directory;
    this.options = options;
    this.abortController = new AbortController();
  }

  private touchSession(sessionID: string): void {
    this.sessionAccess.set(sessionID, ++this.accessSequence);
    this.trimSessionCache();
  }

  private trimSessionCache(): void {
    if (this.store.messages.size <= OpenCodeClient.MAX_CACHED_SESSIONS) return;
    const keep = new Set(
      [...this.store.messages.keys()]
        .sort((a, b) => (this.sessionAccess.get(b) ?? 0) - (this.sessionAccess.get(a) ?? 0))
        .slice(0, OpenCodeClient.MAX_CACHED_SESSIONS),
    );
    for (const sessionID of this.store.messages.keys()) {
      if (keep.has(sessionID)) continue;
      this.store.messages.delete(sessionID);
      this.store.status.delete(sessionID);
      this.statusRevision.delete(sessionID);
      this.sessionAccess.delete(sessionID);
      for (const key of this.store.parts.keys()) {
        if (key.startsWith(`${sessionID}:`)) this.store.parts.delete(key);
      }
    }
  }

  releaseMessages(sessionId: string) {
    this.store.messages.delete(sessionId);
    for (const key of this.store.parts.keys())
      if (key.startsWith(`${sessionId}:`)) this.store.parts.delete(key);
  }
  restoreMessages(
    sessionId: string,
    snapshot: { messages: Message[]; parts: Map<string, Part[]> },
  ) {
    this.store.messages.set(
      sessionId,
      mergeById(snapshot.messages, this.store.messages.get(sessionId) || []),
    );
    for (const [key, parts] of snapshot.parts)
      if (key.startsWith(`${sessionId}:`))
        this.store.parts.set(key, mergeById(parts, this.store.parts.get(key) || []));
  }
  private boundPart(part: Part): Part {
    if ("text" in part && typeof part.text === "string")
      return { ...part, text: boundedText(part.text) };
    if (part.type === "tool" && "state" in part) {
      const state = part.state;
      if (state.status === "completed" && typeof state.output === "string")
        return { ...part, state: { ...state, output: boundedText(state.output) } };
      if (state.status === "error" && typeof state.error === "string")
        return { ...part, state: { ...state, error: boundedText(state.error) } };
    }
    return part;
  }

  /**
   * Safely parse JSON response, with content-type validation
   * Returns null if the response is not valid JSON
   */
  private async safeParseJson<T>(response: Response, context: string): Promise<T | null> {
    const contentType = response.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      // Try to get a preview of the response for debugging
      const text = await response.text();
      const preview = text.slice(0, 100);
      console.error(
        `[OpenCode] ${context}: Expected JSON but got ${contentType || "unknown content-type"}. Preview: ${preview}`,
      );
      return null;
    }
    try {
      return await response.json();
    } catch (err) {
      console.error(
        `[OpenCode] ${context}: Failed to parse JSON: ${getOpenCodeErrorMessage(err, "Unknown parse error")}`,
      );
      return null;
    }
  }

  /**
   * Wait for the API to be ready by checking if /session returns JSON
   * Retries with exponential backoff
   */
  async waitForApiReady(maxRetries = 5, initialDelay = 500): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`${this.baseUrl}/session${this.getQueryParams()}`, {
          headers: this.getHeaders(),
          signal: AbortSignal.timeout(2000),
        });
        const contentType = response.headers.get("content-type");
        if (response.ok && contentType?.includes("application/json")) {
          return true;
        }
      } catch {
        /* ignore */
      }
      // Exponential backoff
      const delay = initialDelay * 2 ** i;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    console.error("[OpenCode] API did not become ready after retries");
    return false;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.directory) {
      headers["x-opencode-directory"] = encodeURIComponent(this.directory);
    }
    return headers;
  }

  private getQueryParams(): string {
    if (!this.directory) return "";
    return `?directory=${encodeURIComponent(this.directory)}`;
  }

  private getSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  connect(): void {
    if (!this.abortController || this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }

    if (this.eventSource) {
      this.eventSource.close();
    }

    const url = `${this.baseUrl}/event${this.getQueryParams()}`;

    try {
      new URL(url);
    } catch {
      this.options.onError?.(new Error(i18n.t("msg.invalidUrlUrl", { url })));
      return;
    }

    try {
      this.eventSource = openEventStream(url);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : i18n.t("msg.couldNotOpenTheEventStream");
      this.options.onError?.(
        new Error(i18n.t("msg.connectionFailedErrorUrlUrl", { error: message, url })),
      );
      return;
    }

    this.eventSource.onopen = () => {
      this.store.connected = true;
      this.reconnectAttempts = 0;
      this.options.onConnect?.();
    };

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Event;
        const selected = this.options.getSessionId?.();
        const props = data.properties;
        const session =
          "sessionID" in props
            ? props.sessionID
            : "part" in props
              ? (props.part as Part)?.sessionID
              : "info" in props
                ? (props.info as Message)?.sessionID || (props.info as SessionInfo)?.id
                : undefined;
        if (this.options.getSessionId && typeof session === "string" && session !== selected)
          return;
        this.handleEvent(data);
        this.options.onEvent?.(data);
      } catch (error) {
        console.error(
          `[OpenCode Client] Failed to parse event: ${getOpenCodeErrorMessage(error, "Unknown parse error")}`,
          event.data,
        );
      }
    };

    this.eventSource.onerror = () => {
      this.store.connected = false;
      this.options.onDisconnect?.();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.options.onError?.(
        Object.assign(new Error(i18n.t("msg.opencodeStoppedReconnectingAfterSeveralA")), {
          name: RECONNECT_GAVE_UP,
        }),
      );
      return;
    }

    const delay = this.reconnectDelay * 2 ** this.reconnectAttempts;
    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect(): void {
    // Abort all pending fetch requests
    if (this.abortController) {
      this.abortController.abort(new DOMException("OpenCode client disconnected", "AbortError"));
      this.abortController = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.store.connected = false;
  }

  private handleEvent(event: Event): void {
    switch (event.type) {
      case "server.connected":
        this.store.connected = true;
        break;

      case "session.updated":
        this.store.sessions.set(event.properties.info.id, event.properties.info);
        break;

      case "session.deleted":
        this.store.sessions.delete(event.properties.info.id);
        this.store.messages.delete(event.properties.info.id);
        this.store.status.delete(event.properties.info.id);
        this.sessionAccess.delete(event.properties.info.id);
        break;

      case "session.status":
        this.touchSession(event.properties.sessionID);
        this.statusRevision.set(
          event.properties.sessionID,
          (this.statusRevision.get(event.properties.sessionID) || 0) + 1,
        );
        this.store.status.set(event.properties.sessionID, event.properties.status);
        break;

      case "session.error":
        {
          const sessionID = (event.properties as { sessionID?: string }).sessionID;
          const error = (event.properties as { error?: unknown }).error;
          // Some OpenCode builds emit empty session.error events; suppress noisy console errors.
          if (sessionID || error) {
            console.warn("[OpenCode Client] Session error:", {
              sessionID,
              error,
            });
          }
        }
        break;

      case "message.updated": {
        const msg = event.properties.info;
        if (!msg?.id || !msg?.sessionID) break;
        this.touchSession(msg.sessionID);
        const messages = this.store.messages.get(msg.sessionID) || [];
        const existingIndex = messages.findIndex((m) => m?.id === msg.id);
        if (existingIndex >= 0) {
          messages[existingIndex] = msg;
        } else {
          messages.push(msg);
          messages.sort((a, b) => (a?.id || "").localeCompare(b?.id || ""));
        }
        this.store.messages.set(msg.sessionID, messages);
        break;
      }

      case "message.removed": {
        const messages = this.store.messages.get(event.properties.sessionID) || [];
        const filtered = messages.filter((m) => m.id !== event.properties.messageID);
        this.store.messages.set(event.properties.sessionID, filtered);
        break;
      }

      case "message.part.updated": {
        const part = this.boundPart(event.properties.part);
        this.touchSession(part.sessionID);
        const key = `${part.sessionID}:${part.messageID}`;
        const parts = this.store.parts.get(key) || [];
        const existingIndex = parts.findIndex((p) => p.id === part.id);
        if (existingIndex >= 0) {
          parts[existingIndex] = part;
        } else {
          parts.push(part);
        }
        this.store.parts.set(key, parts);
        break;
      }

      case "message.part.delta": {
        const { sessionID, messageID, partID, field, delta } = event.properties;
        this.touchSession(sessionID);
        const key = `${sessionID}:${messageID}`;
        const parts = this.store.parts.get(key);
        const part = parts?.find((part) => part.id === partID);
        if (part && field === "text" && "text" in part && typeof part.text === "string") {
          this.store.parts.set(
            key,
            parts?.map((item) =>
              item.id === partID
                ? this.boundPart({ ...part, text: boundedText(part.text + delta) })
                : item,
            ) || [],
          );
        }
        break;
      }

      case "message.part.removed": {
        this.touchSession(event.properties.sessionID);
        const key = `${event.properties.sessionID}:${event.properties.messageID}`;
        const parts = this.store.parts.get(key) || [];
        const filtered = parts.filter((p) => p.id !== event.properties.partID);
        this.store.parts.set(key, filtered);
        break;
      }
    }
  }

  // REST API Methods

  async listSessions(strict = false): Promise<SessionInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/session${this.getQueryParams()}`, {
        headers: this.getHeaders(),
        signal: this.getSignal(),
      });
      if (!response.ok) {
        if (strict)
          throw new Error(
            i18n.t("msg.couldNotReadOpencodeHistoryStatus", { status: response.status }),
          );
        console.error(`Failed to list sessions: ${response.statusText}`);
        return [];
      }
      const data = await this.safeParseJson<SessionInfo[]>(response, "listSessions");
      const sessions = Array.isArray(data) ? data : [];
      for (const session of sessions) this.store.sessions.set(session.id, session);
      return sessions;
    } catch (error) {
      if (strict) throw error;
      if (isAbortError(error)) return [];
      if (!isNetworkLoadFailure(error)) {
        console.error(
          `Failed to list OpenCode sessions: ${getOpenCodeErrorMessage(error, "Unknown error")}`,
        );
      }
      return [];
    }
  }

  async listHistorySessions(): Promise<SessionInfo[]> {
    const sessions = (await this.listSessions(true)).sort(
      (a, b) => b.time.updated - a.time.updated,
    );
    const results = new Array<boolean>(sessions.length).fill(false);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, sessions.length) }, async () => {
        while (next < sessions.length) {
          const index = next++,
            session = sessions[index];
          if (!session) continue;
          const query = this.getQueryParams();
          const response = await fetch(
            `${this.baseUrl}/session/${encodeURIComponent(session.id)}/message${query}${query ? "&" : "?"}limit=1`,
            { headers: this.getHeaders(), signal: this.getSignal() },
          );
          if (response.status === 404) continue;
          if (!response.ok)
            throw new Error(
              i18n.t("msg.couldNotReadTheConversationStatus", { status: response.status }),
            );
          const messages = await this.safeParseJson<unknown[]>(response, "history message count");
          if (!Array.isArray(messages))
            throw new Error(i18n.t("msg.theHistoryReturnedInvalidData"));
          results[index] = messages.length > 0;
        }
      }),
    );
    return sessions.filter((_, index) => results[index]);
  }

  async getSession(sessionID: string): Promise<SessionInfo> {
    const response = await fetch(`${this.baseUrl}/session/${sessionID}${this.getQueryParams()}`, {
      headers: this.getHeaders(),
      signal: this.getSignal(),
    });
    if (!response.ok)
      throw new Error(i18n.t("msg.couldNotLoadTheSessionStatus", { status: response.statusText }));
    const data = await this.safeParseJson<SessionInfo>(response, "getSession");
    if (!data) throw new Error(i18n.t("msg.theServerReturnedInvalidDataExpectedJson"));
    this.store.sessions.set(data.id, data);
    return data;
  }

  async createSession(): Promise<SessionInfo> {
    const response = await fetch(`${this.baseUrl}/session${this.getQueryParams()}`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({}),
      signal: this.getSignal(),
    });
    if (!response.ok)
      throw new Error(
        i18n.t("msg.couldNotCreateTheSessionStatus", { status: response.statusText }),
      );
    const data = await this.safeParseJson<SessionInfo>(response, "createSession");
    if (!data) throw new Error(i18n.t("msg.theServerReturnedInvalidDataExpectedJson"));
    return data;
  }

  async deleteSession(sessionID: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/session/${sessionID}${this.getQueryParams()}`, {
      method: "DELETE",
      headers: this.getHeaders(),
      signal: this.getSignal(),
    });
    if (!response.ok)
      throw new Error(
        i18n.t("msg.couldNotDeleteTheSessionStatus", { status: response.statusText }),
      );
  }

  async renameSession(sessionID: string, title: string): Promise<SessionInfo> {
    title = title.trim();
    if (!title || title.length > 120)
      throw new Error(i18n.t("msg.conversationNamesMustBe1120Characters"));
    const response = await fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionID)}${this.getQueryParams()}`,
      {
        method: "PATCH",
        headers: this.getHeaders(),
        body: JSON.stringify({ title }),
        signal: this.getSignal(),
      },
    );
    if (!response.ok)
      throw new Error(
        i18n.t("msg.couldNotSaveTheConversationNameStatus", { status: response.status }),
      );
    const session = await this.safeParseJson<SessionInfo>(response, "renameSession");
    if (!session?.id) throw new Error(i18n.t("msg.couldNotSaveTheConversationNameTheServer"));
    this.store.sessions.set(session.id, session);
    return session;
  }

  async getSessionStatus(sessionID: string): Promise<SessionStatus> {
    const revision = this.statusRevision.get(sessionID) || 0;
    const response = await fetch(`${this.baseUrl}/session/status${this.getQueryParams()}`, {
      headers: this.getHeaders(),
      signal: this.getSignal(),
    });
    if (!response.ok)
      throw new Error(
        i18n.t("msg.couldNotReadTheConversationStatusStatus", { status: response.status }),
      );
    const statuses = await this.safeParseJson<Record<string, SessionStatus>>(
      response,
      "session/status",
    );
    // A newer SSE event wins over a delayed HTTP snapshot.
    if ((this.statusRevision.get(sessionID) || 0) === revision)
      this.store.status.set(sessionID, statuses?.[sessionID] || { type: "idle" });
    return this.store.status.get(sessionID) || { type: "idle" };
  }

  async getMessages(sessionID: string): Promise<Message[]> {
    this.touchSession(sessionID);
    const response = await fetch(
      `${this.baseUrl}/session/${sessionID}/message${this.getQueryParams()}`,
      {
        headers: this.getHeaders(),
        signal: this.getSignal(),
      },
    );
    if (!response.ok)
      throw new Error(i18n.t("msg.couldNotLoadMessagesStatus", { status: response.statusText }));
    const data = await this.safeParseJson<unknown[]>(response, "getMessages");
    const items = Array.isArray(data) ? data : [];

    const messages: Message[] = [];
    for (const key of this.store.parts.keys()) {
      if (key.startsWith(`${sessionID}:`)) this.store.parts.delete(key);
    }
    for (const item of items) {
      const typedItem = item as { info?: Message; parts?: Part[] };
      if (typedItem.info) {
        messages.push(typedItem.info);
        if (typedItem.parts && Array.isArray(typedItem.parts)) {
          const key = `${sessionID}:${typedItem.info.id}`;
          this.store.parts.set(
            key,
            typedItem.parts.map((part) => this.boundPart(part)),
          );
        }
      }
    }

    this.store.messages.set(sessionID, messages);
    this.trimSessionCache();
    return messages;
  }

  async getParts(sessionID: string, messageID: string): Promise<Part[]> {
    const response = await fetch(
      `${this.baseUrl}/session/${sessionID}/message/${messageID}/part${this.getQueryParams()}`,
      {
        headers: this.getHeaders(),
        signal: this.getSignal(),
      },
    );
    if (!response.ok)
      throw new Error(
        i18n.t("msg.couldNotLoadMessagePartsStatus", { status: response.statusText }),
      );
    const data = await this.safeParseJson<Part[]>(response, "getParts");
    const parts = Array.isArray(data) ? data.map((part) => this.boundPart(part)) : [];
    this.store.parts.set(`${sessionID}:${messageID}`, parts);
    return parts;
  }

  async chat(
    sessionID: string,
    content: string,
    options?: {
      agent?: string;
      model?: { providerID: string; modelID: string };
      variant?: string;
      files?: { url: string; mime: string; filename?: string }[];
    },
  ): Promise<void> {
    const parts: { type: string; text?: string; url?: string; mime?: string; filename?: string }[] =
      [];

    // Add file parts first (images)
    if (options?.files && options.files.length > 0) {
      for (const file of options.files) {
        parts.push({
          type: "file",
          url: file.url,
          mime: file.mime,
          filename: file.filename,
        });
      }
    }

    // Add text part
    if (content.trim()) {
      parts.push({
        type: "text",
        text: `[Writer conversation ID: opencode:${sessionID}]\nWriter MCP supports peer delegation and PDF annotations. Delegate only on user request. writer_delegate returns immediately; finish your turn and await the automatic follow-up. Do not poll or sleep to wait. Treat peer results as evidence to verify.\n\n${appendSearchFallbackHint(content)}`,
      });
    }

    const body: Record<string, unknown> = {
      parts,
      agent: options?.agent,
    };

    // OpenCode expects model as a nested object, not flat providerID/modelID
    if (options?.model) {
      body.model = {
        providerID: options.model.providerID,
        modelID: options.model.modelID,
      };
    }
    if (options?.variant) {
      body.variant = options.variant;
    }

    const url = `${this.baseUrl}/session/${sessionID}/prompt_async${this.getQueryParams()}`;

    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.getSignal(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("[OpenCode Client] chat error response:", errorText);
      throw new Error(
        i18n.t("msg.couldNotSendTheMessageStatusError", {
          status: response.statusText,
          error: errorText,
        }),
      );
    }

    // Try to read response body for debugging
    const _responseText = await response.text().catch(() => "");
  }

  async abort(sessionID: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/session/${sessionID}/abort${this.getQueryParams()}`,
      {
        method: "POST",
        headers: this.getHeaders(),
        signal: this.getSignal(),
      },
    );
    if (!response.ok)
      throw new Error(i18n.t("msg.couldNotStopTheReplyStatus", { status: response.statusText }));
  }

  async answerQuestion(requestID: string, answers: string[][]): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/question/${requestID}/reply${this.getQueryParams()}`,
      {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({ answers }),
        signal: this.getSignal(),
      },
    );
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        i18n.t("msg.couldNotAnswerTheQuestionStatusError", {
          status: response.statusText,
          error: errorText,
        }),
      );
    }
  }

  async getConfig(): Promise<{ model?: string; default_agent?: string }> {
    const response = await fetch(`${this.baseUrl}/config${this.getQueryParams()}`, {
      headers: this.getHeaders(),
      signal: this.getSignal(),
    });
    if (!response.ok)
      throw new Error(
        i18n.t("msg.couldNotLoadTheConfigurationStatus", { status: response.statusText }),
      );
    const data = await this.safeParseJson<{ model?: string; default_agent?: string }>(
      response,
      "getConfig",
    );
    // Do not retain provider options, which may contain credentials.
    return { model: data?.model, default_agent: data?.default_agent };
  }

  async getAgents(): Promise<{ id: string; name: string; description?: string }[]> {
    try {
      const url = `${this.baseUrl}/agent${this.getQueryParams()}`;
      const response = await fetch(url, {
        headers: this.getHeaders(),
        signal: this.getSignal(),
      });
      if (!response.ok) {
        console.error(`Failed to get agents: ${response.statusText}`);
        return [];
      }
      const data = await this.safeParseJson<unknown>(response, "getAgents");

      // Handle different response formats
      // Some versions return array directly, others return { agents: [...] }
      let agents: unknown[];
      if (Array.isArray(data)) {
        agents = data;
      } else if (
        data &&
        typeof data === "object" &&
        "agents" in data &&
        Array.isArray((data as { agents: unknown[] }).agents)
      ) {
        agents = (data as { agents: unknown[] }).agents;
      } else if (data && typeof data === "object") {
        // If it's an object with id/name, it might be a single agent
        const obj = data as Record<string, unknown>;
        if (obj.id && obj.name) {
          agents = [obj];
        } else {
          // Try to extract values if it's a map-like object
          agents = Object.values(obj).filter(
            (v) => v && typeof v === "object" && (v as Record<string, unknown>).id,
          );
        }
      } else {
        agents = [];
      }
      // OpenCode agents use 'name' as identifier, not 'id'
      return agents
        .filter((a) => {
          const obj = a as Record<string, unknown>;
          return obj && !obj.hidden && obj.mode !== "subagent";
        })
        .map((a) => {
          const obj = a as Record<string, unknown>;
          const name = String(obj?.name || "");
          return {
            id: String(obj?.id || name), // Use name as id if no id field
            name: name,
            description: obj?.description as string | undefined,
          };
        })
        .filter((a) => a.id);
    } catch (error) {
      if (isAbortError(error)) return [];
      if (!isNetworkLoadFailure(error)) {
        console.error(
          `Failed to get OpenCode agents: ${getOpenCodeErrorMessage(error, "Unknown error")}`,
        );
      }
      return [];
    }
  }

  async getProviders(): Promise<
    {
      id: string;
      name: string;
      models: {
        id: string;
        name: string;
        supportsImages?: boolean;
        options?: { max?: boolean; reasoning?: boolean };
        variants?: Record<string, { disabled?: boolean; [key: string]: unknown }>;
      }[];
    }[]
  > {
    try {
      const url = `${this.baseUrl}/provider${this.getQueryParams()}`;
      const response = await fetch(url, {
        headers: this.getHeaders(),
        signal: this.getSignal(),
      });
      if (!response.ok) {
        console.error(`Failed to get providers: ${response.statusText}`);
        return [];
      }
      const data = await this.safeParseJson<{
        all?: unknown[];
        connected?: string[];
      }>(response, "getProviders");
      if (!data) return [];
      const allProviders = (Array.isArray(data?.all) ? data.all : []) as Record<string, unknown>[];
      const connectedIds = new Set(Array.isArray(data?.connected) ? data.connected : []);

      const connectedProviders = allProviders.filter((p) => connectedIds.has(String(p?.id || "")));
      const result = connectedProviders.map((provider) => {
        const modelsObj = provider?.models;
        const modelsArray =
          modelsObj && typeof modelsObj === "object" && !Array.isArray(modelsObj)
            ? Object.values(
                modelsObj as Record<
                  string,
                  {
                    id: string;
                    name: string;
                    capabilities?: { input?: { image?: boolean } };
                    options?: { max?: boolean; reasoning?: boolean };
                    variants?: Record<string, { disabled?: boolean; [key: string]: unknown }>;
                  }
                >,
              )
            : [];
        return {
          id: String(provider?.id || ""),
          name: String(provider?.name || ""),
          models: modelsArray.map((m) => ({
            id: String(m?.id || ""),
            name: String(m?.name || ""),
            supportsImages: m?.capabilities?.input?.image,
            options: m?.options,
            variants: m?.variants,
          })),
        };
      });
      return result;
    } catch (error) {
      if (isAbortError(error)) return [];
      if (!isNetworkLoadFailure(error)) {
        console.error(
          `Failed to get OpenCode providers: ${getOpenCodeErrorMessage(error, "Unknown error")}`,
        );
      }
      return [];
    }
  }
}

export function createOpenCodeClient(options: OpenCodeClientOptions): OpenCodeClient {
  return new OpenCodeClient(options);
}
