"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { workbenchI18n as i18n } from "../../i18n";
import { agentPlatform } from "../platform";
import {
  createOpenCodeClient,
  getOpenCodeErrorMessage,
  isAbortError,
  type OpenCodeClient,
  type OpenCodeTransport,
  RECONNECT_GAVE_UP,
} from "./client";
import { isVariantSupported, selectInitialModel } from "./model-selection";
import { STORAGE_KEY_AGENT, STORAGE_KEY_MODEL } from "./preferences";
import {
  buildWebsearchFallbackPrompt,
  getWebsearchFallbackFailure,
  isPerplexitySearchPart,
  type WebsearchFallbackFailure,
} from "./search-fallback";
import type { Event, Message, Part, QuestionAsked, SessionInfo, SessionStatus } from "./types";

export type UseOpenCodeOptions = {
  baseUrl?: string;
  /** Relays requests and events instead of plain HTTP to `baseUrl` (the web app). */
  transport?: OpenCodeTransport;
  directory?: string;
  autoConnect?: boolean;
  initialSessionId?: string | null;
};

export type Agent = { id: string; name: string; description?: string };
export type Model = {
  supportsImages?: boolean;
  id: string;
  name: string;
  options?: {
    max?: boolean;
    reasoning?: boolean;
  };
  variants?: Record<string, { disabled?: boolean; [key: string]: unknown }>;
};
export type Provider = {
  id: string;
  name: string;
  models: Model[];
};

export type SelectedModel = {
  providerId: string;
  modelId: string;
  variant?: string;
};

export type UseOpenCodeReturn = {
  connected: boolean;
  ready: boolean;
  connecting: boolean;
  error: string | null;
  maxReconnectFailed: boolean;

  sessions: SessionInfo[];
  currentSession: SessionInfo | null;
  currentSessionId: string | null;
  messages: Message[];
  parts: Map<string, Part[]>;
  releaseHistory: () => void;
  restoreHistory: (snapshot: { messages: Message[]; parts: Map<string, Part[]> }) => void;
  status: SessionStatus;
  completion: number;
  currentQuestion: QuestionAsked | null;

  agents: Agent[];
  providers: Provider[];
  selectedAgent: string | null;
  selectedModel: SelectedModel | null;

  connect: () => void;
  disconnect: () => void;
  createSession: () => Promise<SessionInfo | null>;
  selectSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  sendMessage: (
    content: string,
    files?: { url: string; mime: string; filename?: string }[],
    steer?: boolean,
  ) => Promise<boolean>;
  answerQuestion: (questionID: string, answers: string[][]) => Promise<void>;
  abort: () => Promise<void>;
  getPartsForMessage: (messageId: string) => Part[];
  resetReconnectState: () => void;
  setSelectedAgent: (agentId: string | null) => void;
  setSelectedModel: (model: SelectedModel | null) => void;
};

const DEFAULT_BASE_URL = "http://localhost:4096";

const FALLBACK_MODELS_BY_PROVIDER: Record<string, string[]> = {
  openai: ["gpt-5.4", "gpt-5", "gpt-5.1"],
  codex: ["gpt-5.4", "gpt-5", "gpt-5.1"],
};

function pickFallbackModel(provider: Provider): Model | undefined {
  const providerKey = `${provider.id} ${provider.name}`.toLowerCase();
  const fallbackModels = Object.entries(FALLBACK_MODELS_BY_PROVIDER).find(([key]) =>
    providerKey.includes(key),
  )?.[1];

  if (fallbackModels) {
    for (const fallbackModel of fallbackModels) {
      const exactMatch = provider.models.find((m) => m.id.toLowerCase() === fallbackModel);
      if (exactMatch) return exactMatch;

      const model = provider.models.find((m) => m.id.toLowerCase().includes(fallbackModel));
      if (model) return model;
    }
  }

  return undefined;
}

function isUnsupportedModelError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unsupported_model") ||
    normalized.includes("model_not_supported") ||
    normalized.includes("entitlement") ||
    normalized.includes("not currently available")
  );
}

export function useOpenCode(options: UseOpenCodeOptions = {}): UseOpenCodeReturn {
  const {
    baseUrl = DEFAULT_BASE_URL,
    directory,
    autoConnect = false,
    initialSessionId,
    transport,
  } = options;

  const clientRef = useRef<OpenCodeClient | null>(null);
  const initialSession = useRef(initialSessionId);
  const sessionBootstrap = useRef(false);
  const [dataReady, setDataReady] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(Boolean(initialSessionId));
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxReconnectFailed, setMaxReconnectFailed] = useState(false);
  const wasConnectedRef = useRef(false);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(initialSessionId ?? null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [parts, setParts] = useState<Map<string, Part[]>>(new Map());
  const [status, setStatus] = useState<SessionStatus>({ type: "idle" });
  const [completion, setCompletion] = useState(0);
  const [currentQuestion, setCurrentQuestion] = useState<QuestionAsked | null>(null);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<SelectedModel | null>(null);

  const currentSessionIdRef = useRef<string | null>(initialSessionId ?? null);
  currentSessionIdRef.current = currentSessionId;

  const sessionErrorRetryCountRef = useRef(0);
  const maxSessionErrorRetries = 3;

  const selectedAgentRef = useRef<string | null>(null);
  selectedAgentRef.current = selectedAgent;
  const selectedModelRef = useRef<SelectedModel | null>(null);
  selectedModelRef.current = selectedModel;
  const providersRef = useRef<Provider[]>([]);
  providersRef.current = providers;
  const lastSendRef = useRef<{
    content: string;
    files?: { url: string; mime: string; filename?: string }[];
    agent?: string;
    sessionId: string;
    retriedUnsupportedModel: boolean;
  } | null>(null);
  const pendingWebsearchFallbacksRef = useRef<Map<string, WebsearchFallbackFailure[]>>(new Map());
  const queuedWebsearchFallbackPartIdsRef = useRef<Set<string>>(new Set());

  // Sync messages and parts only (not status) - used after sending messages
  const syncMessagesAndPartsRef = useRef<() => void>(() => {});
  syncMessagesAndPartsRef.current = () => {
    const client = clientRef.current;
    if (!client) return;

    const sessionId = currentSessionIdRef.current;
    if (sessionId) {
      const newMessages = client.store.messages.get(sessionId) || [];

      setMessages(newMessages);

      const sessionParts = new Map<string, Part[]>();
      for (const [key, value] of client.store.parts.entries()) {
        if (key.startsWith(`${sessionId}:`)) {
          sessionParts.set(key, value);
        }
      }
      setParts(sessionParts);
    }
  };

  const syncFromStoreRef = useRef<() => void>(() => {});
  syncFromStoreRef.current = () => {
    const client = clientRef.current;
    if (!client) return;

    setSessions(Array.from(client.store.sessions.values()));

    const sessionId = currentSessionIdRef.current;
    if (sessionId) {
      const newMessages = client.store.messages.get(sessionId) || [];
      const newStatus = client.store.status.get(sessionId) || { type: "idle" };

      setMessages(newMessages);
      setStatus(newStatus);

      const sessionParts = new Map<string, Part[]>();
      for (const [key, value] of client.store.parts.entries()) {
        if (key.startsWith(`${sessionId}:`)) {
          sessionParts.set(key, value);
        }
      }
      setParts(sessionParts);
    }
  };

  const syncFromStore = useCallback(() => {
    syncFromStoreRef.current();
  }, []);
  // Streaming emits one event per token; re-render the transcript at most every 32 ms.
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSync = () => {
    if (syncTimerRef.current) return;
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      syncFromStoreRef.current();
    }, 32);
  };
  useEffect(
    () => () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    },
    [],
  );

  const flushWebsearchFallbackRef = useRef<(sessionId: string) => void>(() => {});
  flushWebsearchFallbackRef.current = (sessionId: string) => {
    const failures = pendingWebsearchFallbacksRef.current.get(sessionId);
    if (!failures?.length) return;

    pendingWebsearchFallbacksRef.current.delete(sessionId);

    const client = clientRef.current;
    if (!client || currentSessionIdRef.current !== sessionId) return;

    const prompt = buildWebsearchFallbackPrompt(failures);
    const selected = selectedModelRef.current;
    const agent = selectedAgentRef.current ?? undefined;

    lastSendRef.current = {
      content: prompt,
      agent,
      sessionId,
      retriedUnsupportedModel: false,
    };
    setError(null);
    setStatus({ type: "running" });
    client
      .chat(sessionId, prompt, {
        agent,
        model: selected
          ? {
              providerID: selected.providerId,
              modelID: selected.modelId,
            }
          : undefined,
        variant: selected?.variant,
      })
      .then(() => {
        setTimeout(() => {
          syncMessagesAndPartsRef.current();
        }, 500);
      })
      .catch((err) => {
        if (isAbortError(err)) {
          setStatus({ type: "idle" });
          return;
        }
        console.error(
          `[OpenCode] websearch fallback failed: ${getOpenCodeErrorMessage(err, "Unknown error")}`,
        );
        setStatus({ type: "idle" });
        setError(err instanceof Error ? err.message : i18n.t("msg.failedToRunWebsearchFallback"));
      });
  };

  const handleEventRef = useRef<(event: Event) => void>(() => {});
  handleEventRef.current = (event: Event) => {
    if ("properties" in event) {
      const props = event.properties as Record<string, unknown>;
      const eventSessionId =
        props.sessionID ||
        (props.info as { sessionID?: string })?.sessionID ||
        (props.part as { sessionID?: string })?.sessionID;

      if (event.type === "session.updated" || event.type === "session.deleted") {
        syncFromStoreRef.current();
        return;
      }

      // Handle session.status events immediately for responsive UI
      if (event.type === "session.status" && eventSessionId === currentSessionIdRef.current) {
        const statusData = props.status as SessionStatus | undefined;
        if (statusData) {
          setStatus(statusData);
        }
        if (statusData?.type === "idle") {
          setCompletion((value) => value + 1);
          flushWebsearchFallbackRef.current(eventSessionId as string);
        }
      }

      if (event.type === "session.idle" && eventSessionId === currentSessionIdRef.current) {
        // Deprecated mirror of session.status. Counting both would make a queued
        // turn appear completed twice and could release the following message early.
        flushWebsearchFallbackRef.current(eventSessionId as string);
      }

      if (event.type === "message.part.updated" && eventSessionId === currentSessionIdRef.current) {
        const part = event.properties.part;
        if (isPerplexitySearchPart(part)) {
          pendingWebsearchFallbacksRef.current.delete(eventSessionId as string);
        }

        const failure = getWebsearchFallbackFailure(part);
        if (failure && !queuedWebsearchFallbackPartIdsRef.current.has(failure.partId)) {
          queuedWebsearchFallbackPartIdsRef.current.add(failure.partId);
          const sessionFallbacks =
            pendingWebsearchFallbacksRef.current.get(eventSessionId as string) ?? [];
          sessionFallbacks.push(failure);
          pendingWebsearchFallbacksRef.current.set(eventSessionId as string, sessionFallbacks);
        }
      }

      // Handle question.asked events
      if (event.type === "question.asked") {
        const questionData = event.properties as QuestionAsked;
        if (questionData.sessionID === currentSessionIdRef.current) {
          setCurrentQuestion(questionData);
        }
      }

      // Handle session.error events - auto-recover or show error to user
      if (event.type === "session.error") {
        const errorSessionId = event.properties.sessionID;
        if (errorSessionId === currentSessionIdRef.current) {
          const errorData = event.properties.error as
            | { data?: { message?: string; providerID?: string }; name?: string }
            | undefined;

          // Parse error message
          let errorMessage = errorData?.data?.message || errorData?.name || "Unknown error";

          if (isUnsupportedModelError(errorMessage)) {
            const selected = selectedModelRef.current;
            const lastSend = lastSendRef.current;
            const provider = selected
              ? providersRef.current.find((p) => p.id === selected.providerId)
              : undefined;
            const fallbackModel = provider ? pickFallbackModel(provider) : undefined;

            if (
              selected &&
              lastSend &&
              fallbackModel &&
              fallbackModel.id !== selected.modelId &&
              lastSend.sessionId === errorSessionId &&
              !lastSend.retriedUnsupportedModel
            ) {
              lastSend.retriedUnsupportedModel = true;
              const fallbackSelection = {
                providerId: selected.providerId,
                modelId: fallbackModel.id,
                variant: isVariantSupported(fallbackModel, selected.variant)
                  ? selected.variant
                  : undefined,
              };
              selectedModelRef.current = fallbackSelection;
              setSelectedModel(fallbackSelection);
              try {
                localStorage.setItem(STORAGE_KEY_MODEL, JSON.stringify(fallbackSelection));
              } catch {
                // Ignore localStorage errors
              }

              const client = clientRef.current;
              if (client) {
                setError(null);
                setStatus({ type: "running" });
                // Retry in the same conversation: a new session would silently detach this
                // tab from its history, queue and Writer conversation ID.
                Promise.resolve()
                  .then(async () => {
                    await client.chat(errorSessionId, lastSend.content, {
                      agent: lastSend.agent,
                      model: {
                        providerID: fallbackSelection.providerId,
                        modelID: fallbackSelection.modelId,
                      },
                      variant: fallbackSelection.variant,
                      files: lastSend.files,
                    });
                    setTimeout(() => {
                      syncMessagesAndPartsRef.current();
                    }, 500);
                  })
                  .catch((err) => {
                    if (isAbortError(err)) {
                      setStatus({ type: "idle" });
                      return;
                    }
                    console.error(
                      `[OpenCode] Unsupported model fallback failed: ${getOpenCodeErrorMessage(err, "Unknown error")}`,
                    );
                    setStatus({ type: "idle" });
                    setError(
                      err instanceof Error
                        ? err.message
                        : `Model unavailable. Switched to ${fallbackSelection.modelId}; please retry.`,
                    );
                  });
                return;
              }
            }

            setStatus({ type: "idle" });
            setError(errorMessage);
            return;
          }

          // Check if this is a non-recoverable error (billing, credits, etc.)
          const isNonRecoverable =
            errorMessage.includes("CreditsError") ||
            errorMessage.includes("No payment method") ||
            errorMessage.includes("billing") ||
            errorMessage.includes("quota") ||
            errorMessage.includes("rate limit");

          if (isNonRecoverable) {
            // Parse nested JSON for billing errors
            try {
              const jsonMatch = errorMessage.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.error?.message) {
                  errorMessage = parsed.error.message;
                }
              }
            } catch {
              // Keep original error message
            }
            const providerInfo = errorData?.data?.providerID
              ? ` (Provider: ${errorData.data.providerID})`
              : "";
            setError(`${errorMessage}${providerInfo}`);
          } else {
            // Recoverable error - try to auto-recover by creating new session
            sessionErrorRetryCountRef.current++;

            if (sessionErrorRetryCountRef.current <= maxSessionErrorRetries) {
              // Clear error and create new session
              setError(null);
              const client = clientRef.current;
              if (client) {
                client
                  .createSession()
                  .then((newSession) => {
                    if (newSession) {
                      setCurrentSessionId(newSession.id);
                      syncFromStoreRef.current();
                      sessionErrorRetryCountRef.current = 0;
                    }
                  })
                  .catch((err) => {
                    console.error(
                      `[OpenCode] Auto-recovery failed: ${getOpenCodeErrorMessage(err, "Unknown error")}`,
                    );
                    setError(i18n.t("msg.sessionErrorPleaseTryAgain"));
                  });
              }
            } else {
              // Max retries reached
              console.error("[OpenCode] Max session error retries reached");
              setError(i18n.t("msg.sessionKeepsFailingPleaseRestartOpencode"));
              sessionErrorRetryCountRef.current = 0;
            }
          }
        }
      }

      if (eventSessionId && eventSessionId === currentSessionIdRef.current) {
        scheduleSync();
      }
    }
  };

  useEffect(() => {
    const client = createOpenCodeClient({
      baseUrl,
      transport,
      directory,
      getSessionId: () => currentSessionIdRef.current,
      onEvent: (event) => handleEventRef.current(event),
      onConnect: () => {
        setConnected(true);
        setConnecting(false);
        setError(null);
        setMaxReconnectFailed(false);
        wasConnectedRef.current = true;
      },
      onDisconnect: () => {
        setDataReady(false);
        setConnected(false);
        setConnecting(false);
      },
      onError: (err) => {
        if (isAbortError(err)) {
          setConnecting(false);
          return;
        }
        setError(err.message);
        setConnecting(false);
        if (err.name === RECONNECT_GAVE_UP) {
          setMaxReconnectFailed(true);
        }
      },
    });

    clientRef.current = client;

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [baseUrl, directory, transport]);

  useEffect(() => {
    if (autoConnect && !connected && !connecting) {
      setConnecting(true);
      clientRef.current?.connect();
    }
  }, [autoConnect, connected, connecting]);

  const loadSessions = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !connected) return;

    try {
      const sessionList = await client.listSessions();
      const safeSessions = Array.isArray(sessionList) ? sessionList : [];
      setSessions(safeSessions);

      if (
        initialSession.current === undefined &&
        safeSessions.length > 0 &&
        !currentSessionIdRef.current
      ) {
        const sorted = [...safeSessions].sort((a, b) => b.time.updated - a.time.updated);
        const firstSession = sorted[0];
        if (firstSession) {
          currentSessionIdRef.current = firstSession.id;
          setCurrentSessionId(firstSession.id);
          const [msgs] = await Promise.all([
            client.getMessages(firstSession.id),
            client.getSessionStatus(firstSession.id),
          ]);
          setMessages(msgs);
          setStatus(client.store.status.get(firstSession.id) || { type: "idle" });

          // Parts are already included in messages
          const sessionParts = new Map<string, Part[]>();
          for (const [key, value] of client.store.parts.entries()) {
            if (key.startsWith(`${firstSession.id}:`)) {
              sessionParts.set(key, value);
            }
          }
          setParts(sessionParts);
        }
      }
    } catch (err) {
      if (isAbortError(err)) return;
      console.error(
        `Failed to load OpenCode sessions: ${getOpenCodeErrorMessage(err, "Unknown error")}`,
      );
      setSessions([]);
    }
  }, [connected]);

  const loadConfig = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !connected) return;

    try {
      const [agentList, providerList, config] = await Promise.all([
        client.getAgents(),
        client.getProviders(),
        client.getConfig(),
      ]);
      const safeAgents = Array.isArray(agentList) ? agentList : [];
      const safeProviders = Array.isArray(providerList) ? providerList : [];

      setAgents(safeAgents);
      setProviders(safeProviders);

      // Load saved preferences from localStorage
      let savedAgent: string | null = null;
      let savedModel: SelectedModel | null = null;
      try {
        savedAgent = localStorage.getItem(STORAGE_KEY_AGENT);
        const savedModelStr = localStorage.getItem(STORAGE_KEY_MODEL);
        if (savedModelStr) {
          savedModel = JSON.parse(savedModelStr);
        }
      } catch {
        // Ignore localStorage errors
      }

      // Agent selection: prefer saved, then the configured default.
      if (!selectedAgentRef.current) {
        if (savedAgent && safeAgents.some((a) => a.id === savedAgent)) {
          setSelectedAgent(savedAgent);
        } else {
          const firstAgent =
            safeAgents.find((agent) => agent.id === config.default_agent) ?? safeAgents[0];
          if (firstAgent) {
            setSelectedAgent(firstAgent.id);
          }
        }
      }

      if (!selectedModelRef.current) {
        setSelectedModel(selectInitialModel(safeProviders, config.model, savedModel));
      }
    } catch (err) {
      if (isAbortError(err)) return;
      console.error(
        `Failed to load OpenCode config: ${getOpenCodeErrorMessage(err, "Unknown error")}`,
      );
      setAgents([]);
      setProviders([]);
    }
  }, [connected]);

  useEffect(() => {
    if (connected) {
      // Wait for API to be ready before loading data
      // EventSource may connect before REST endpoints are ready
      const client = clientRef.current;
      if (!client) return;

      let cancelled = false;
      const initData = async () => {
        // Wait for API to return JSON (with retries)
        const ready = await client.waitForApiReady();
        if (cancelled) return;

        if (ready) {
          await Promise.all([loadSessions(), loadConfig()]);
          if (!cancelled) setDataReady(true);
        } else {
          console.error("[OpenCode] API not ready, skipping initial data load");
        }
      };

      initData();
      return () => {
        cancelled = true;
      };
    }
  }, [connected, loadSessions, loadConfig]);

  const connect = useCallback(() => {
    const client = clientRef.current;
    if (!client || connected || connecting) return;

    setConnecting(true);
    setError(null);
    client.connect();
  }, [connected, connecting]);

  const disconnect = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;

    client.disconnect();
    setConnected(false);
  }, []);

  const createSession = useCallback(async (): Promise<SessionInfo | null> => {
    const client = clientRef.current;
    if (!client || !connected) return null;

    try {
      const session = await client.createSession();
      currentSessionIdRef.current = session.id;
      setCurrentSessionId(session.id);
      syncFromStore();
      sessionErrorRetryCountRef.current = 0;
      return session;
    } catch (err) {
      if (isAbortError(err)) return null;
      setError(err instanceof Error ? err.message : i18n.t("msg.failedToCreateSession"));
      return null;
    }
  }, [connected, syncFromStore]);

  const selectSession = useCallback(
    async (sessionId: string) => {
      const client = clientRef.current;
      if (!client || !connected) return;

      setSessionLoading(true);
      currentSessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);

      try {
        const [msgs] = await Promise.all([
          client.getMessages(sessionId),
          client.getSessionStatus(sessionId),
        ]);
        setMessages(msgs);
        setStatus(client.store.status.get(sessionId) || { type: "idle" });

        const sessionParts = new Map<string, Part[]>();
        for (const [key, value] of client.store.parts.entries()) {
          if (key.startsWith(`${sessionId}:`)) {
            sessionParts.set(key, value);
          }
        }
        setParts(sessionParts);

        // Parts are already included in messages
        const updatedParts = new Map<string, Part[]>();
        for (const [key, value] of client.store.parts.entries()) {
          if (key.startsWith(`${sessionId}:`)) {
            updatedParts.set(key, value);
          }
        }
        setParts(updatedParts);

        const lastUserMessage = [...msgs]
          .reverse()
          .find((m): m is import("./types").UserMessage => m.role === "user");
        if (lastUserMessage) {
          if (lastUserMessage.agent) {
            setSelectedAgent(lastUserMessage.agent);
          }
          if (lastUserMessage.model?.providerID && lastUserMessage.model?.modelID) {
            setSelectedModel({
              providerId: lastUserMessage.model.providerID,
              modelId: lastUserMessage.model.modelID,
              variant: lastUserMessage.model.variant,
            });
          }
        }
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : i18n.t("msg.failedToLoadSession"));
      } finally {
        setSessionLoading(false);
      }
    },
    [connected],
  );

  useEffect(() => {
    if (!connected || !dataReady || initialSession.current === undefined) return;
    if (sessionBootstrap.current) {
      if (currentSessionIdRef.current) void selectSession(currentSessionIdRef.current);
      return;
    }
    sessionBootstrap.current = true;
    if (initialSession.current) void selectSession(initialSession.current);
    // A new tab stays local until the user actually sends a message.
  }, [connected, dataReady, selectSession]);

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      const client = clientRef.current;
      if (!client || !connected) throw new Error(i18n.t("msg.connectToOpencodeFirst"));
      const session = await client.renameSession(sessionId, title);
      setSessions((current) => current.map((entry) => (entry.id === sessionId ? session : entry)));
    },
    [connected],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const client = clientRef.current;
      if (!client || !connected) return;

      try {
        await client.deleteSession(sessionId);
        if (currentSessionId === sessionId) {
          setCurrentSessionId(null);
          setMessages([]);
          setParts(new Map());
          setStatus({ type: "idle" });
        }
        syncFromStore();
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : i18n.t("msg.failedToDeleteSession"));
      }
    },
    [connected, currentSessionId, syncFromStore],
  );

  const syncMessagesAndParts = useCallback(() => {
    syncMessagesAndPartsRef.current();
  }, []);

  const sendMessage = useCallback(
    async (
      content: string,
      files?: { url: string; mime: string; filename?: string }[],
      steer = false,
    ) => {
      const client = clientRef.current;

      const sessionId = currentSessionIdRef.current;
      if (!client || !connected || !sessionId) {
        setError(i18n.t("msg.connectToOpencodeAndChooseASessionFirst"));
        return false;
      }
      const modelInfo = providers
        .find((provider) => provider.id === selectedModel?.providerId)
        ?.models.find((model) => model.id === selectedModel?.modelId);
      if (files?.length && modelInfo?.supportsImages === false) {
        setError(i18n.t("msg.theCurrentModelIsConfiguredForTextOnlySw"));
        return false;
      }
      setError(null);
      setStatus({ type: "running" });

      // Use first available agent if none selected
      const agentToUse = selectedAgent || agents[0]?.id || undefined;

      try {
        lastSendRef.current = {
          content,
          files,
          agent: agentToUse,
          sessionId,
          retriedUnsupportedModel: false,
        };
        if (directory && !steer)
          await agentPlatform().beforeAgentTurn?.(directory, `opencode:${sessionId}`);
        await client.chat(sessionId, content, {
          agent: agentToUse,
          model: selectedModel
            ? {
                providerID: selectedModel.providerId,
                modelID: selectedModel.modelId,
              }
            : undefined,
          variant: selectedModel?.variant,
          files,
        });
        // Sync messages/parts after a short delay, but NOT status
        // Status will be updated by session.status events from server
        setTimeout(() => {
          syncMessagesAndParts();
        }, 500);
        return true;
      } catch (err) {
        if (isAbortError(err)) {
          if (!steer) setStatus({ type: "idle" });
          return false;
        }
        console.error(
          `[OpenCode] sendMessage error: ${getOpenCodeErrorMessage(err, "Unknown error")}`,
        );
        // On error, reset status to idle and show error
        if (!steer) setStatus({ type: "idle" });
        setError(err instanceof Error ? err.message : i18n.t("msg.failedToSendMessage"));
        return false;
      }
    },
    [connected, syncMessagesAndParts, selectedAgent, selectedModel, agents, providers, directory],
  );

  const abort = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !connected || !currentSessionId) return;

    try {
      await client.abort(currentSessionId);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : i18n.t("msg.failedToAbort"));
    }
  }, [connected, currentSessionId]);

  const answerQuestion = useCallback(
    async (questionID: string, answers: string[][]) => {
      const client = clientRef.current;
      if (!client || !connected) {
        return;
      }

      try {
        await client.answerQuestion(questionID, answers);
        setCurrentQuestion(null);
      } catch (err) {
        if (isAbortError(err)) return;
        console.error(
          `[OpenCode] Failed to answer question: ${getOpenCodeErrorMessage(err, "Unknown error")}`,
        );
        setError(err instanceof Error ? err.message : i18n.t("msg.failedToAnswerQuestion"));
      }
    },
    [connected],
  );

  const getPartsForMessage = useCallback(
    (messageId: string): Part[] => {
      if (!currentSessionId) return [];
      const key = `${currentSessionId}:${messageId}`;
      return parts.get(key) || [];
    },
    [currentSessionId, parts],
  );

  const resetReconnectState = useCallback(() => {
    setMaxReconnectFailed(false);
    setError(null);
    wasConnectedRef.current = false;
  }, []);

  // Wrapped setters that persist to localStorage
  const handleSetSelectedAgent = useCallback((agentId: string | null) => {
    setSelectedAgent(agentId);
    try {
      if (agentId) {
        localStorage.setItem(STORAGE_KEY_AGENT, agentId);
      } else {
        localStorage.removeItem(STORAGE_KEY_AGENT);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const handleSetSelectedModel = useCallback((model: SelectedModel | null) => {
    setSelectedModel(model);
    try {
      if (model) {
        localStorage.setItem(STORAGE_KEY_MODEL, JSON.stringify(model));
      } else {
        localStorage.removeItem(STORAGE_KEY_MODEL);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const currentSession = currentSessionId
    ? sessions.find((s) => s.id === currentSessionId) || null
    : null;
  const releaseHistory = useCallback(() => {
    const sessionId = currentSessionIdRef.current;
    if (sessionId) clientRef.current?.releaseMessages(sessionId);
    setMessages([]);
    setParts(new Map());
  }, []);
  const restoreHistory = useCallback(
    (snapshot: { messages: Message[]; parts: Map<string, Part[]> }) => {
      const sessionId = currentSessionIdRef.current;
      if (sessionId) clientRef.current?.restoreMessages(sessionId, snapshot);
      syncMessagesAndPartsRef.current();
    },
    [],
  );

  return {
    connected,
    ready: connected && dataReady && !sessionLoading,
    connecting,
    error,
    maxReconnectFailed,
    sessions,
    currentSession,
    currentSessionId,
    messages,
    parts,
    releaseHistory,
    restoreHistory,
    status,
    completion,
    currentQuestion,
    agents,
    providers,
    selectedAgent,
    selectedModel,
    connect,
    disconnect,
    createSession,
    selectSession,
    deleteSession,
    renameSession,
    sendMessage,
    answerQuestion,
    abort,
    getPartsForMessage,
    resetReconnectState,
    setSelectedAgent: handleSetSelectedAgent,
    setSelectedModel: handleSetSelectedModel,
  };
}
