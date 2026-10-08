"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { Props as OpenCodeProps } from "@/components/opencode/types";
import {
  HARNESSES,
  type HarnessId,
  type HarnessPanelProps,
  harnessLabel,
  STATUS_LABELS,
} from "@/lib/harness/types";
import type { useHarnessWorkspace } from "@/lib/harness/use-workspace";
import { canClose } from "@/lib/harness/workspace";
import { HarnessErrorBoundary } from "./error-boundary";
import { HistoryDialog } from "./history-dialog";
import { useI18n } from "@/lib/i18n";

const PANELS = {
  opencode: dynamic(
    () => import("@/components/opencode/opencode-panel").then((m) => m.OpenCodePanel),
    { ssr: false },
  ),
  codex: dynamic(() => import("@/components/codex/codex-panel").then((m) => m.CodexPanel), {
    ssr: false,
  }),
  claude: dynamic(() => import("@/components/claude/claude-panel").then((m) => m.ClaudePanel), {
    ssr: false,
  }),
};
type Workspace = ReturnType<typeof useHarnessWorkspace>;
export function HarnessButtons({
  workspace,
  onChoose,
}: {
  workspace: Workspace;
  onChoose: (backend: HarnessId) => void;
}) {
  const { t } = useI18n();
  const active = workspace.tabs.find((t) => t.id === workspace.activeId)?.backend;
  return (
    <fieldset className="flex shrink-0 gap-1" aria-label={t("harness.aiBackends")}>
      {HARNESSES.map((h) => {
        const count = workspace.tabs.filter(
          (t) => t.backend === h.id && ["running", "waiting"].includes(t.status),
        ).length;
        return (
          <button
            type="button"
            key={h.id}
            className={`border px-2 py-1 text-xs ${active === h.id ? "border-foreground bg-foreground text-background" : "border-border hover:bg-accent-hover"}`}
            disabled={!workspace.ready}
            onClick={() => onChoose(h.id)}
            title={t("harness.returnToTheLastNameConversationUseOnTheR", { name: h.label })}
          >
            {h.label}
            {count > 0 && <span className="ml-1 text-accent">{count} ●</span>}
          </button>
        );
      })}
    </fieldset>
  );
}
export function HarnessWorkspace({
  workspace,
  visible,
  preferredBackend = "codex",
  shared,
  opencode,
  onBackendChange,
}: {
  workspace: Workspace;
  visible: boolean;
  preferredBackend?: HarnessId;
  shared: Omit<HarnessPanelProps, "active" | "onWorkingChange">;
  opencode: Pick<
    OpenCodeProps,
    "baseUrl" | "autoConnect" | "daemonStatus" | "onRestartOpenCode" | "onMaxReconnectFailed"
  >;
  onBackendChange: (backend: HarnessId) => void;
}) {
  const { t } = useI18n();
  const [historyBackend, setHistoryBackend] = useState<HarnessId | null>(null);
  const [renamedConversation, setRenamedConversation] = useState<
    { backend: HarnessId; id: string; title: string } | undefined
  >();
  const strip = useRef<HTMLDivElement>(null);
  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeId);
  const select = (id: string, backend: HarnessId) => {
    workspace.select(id);
    onBackendChange(backend);
  };
  useEffect(() => {
    if (!workspace.activeId || !strip.current) return;
    const reveal = () =>
      strip.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, [workspace.activeId]);

  return (
    <>
      <div className="flex shrink-0 border-b border-border bg-background">
        <div
          ref={strip}
          role="tablist"
          aria-label={t("harness.conversations")}
          className="writer-conversation-tabs flex min-w-0 flex-1 overflow-x-auto"
          onWheel={(event) => {
            if (strip.current && Math.abs(event.deltaY) > Math.abs(event.deltaX))
              strip.current.scrollLeft += event.deltaY;
          }}
        >
          {(workspace.ready ? workspace.tabs : []).map((tab) => {
            const pending = workspace.incoming[tab.id]?.length || 0;
            const details = [
              `${harnessLabel(tab.backend)} · ${t(STATUS_LABELS[tab.status])}`,
              tab.queued ? t("harness.queueCount", { count: tab.queued }) : "",
              tab.hasDraft ? t("harness.draft") : "",
              pending ? t("harness.toDeliverCount", { count: pending }) : "",
            ].filter(Boolean);
            const title = `${tab.title}\n${details.join(" · ")}\n${tab.sessionId || t("harness.noSessionStartedYet")}`;
            return (
              <div
                key={tab.id}
                className={`flex shrink-0 items-center border-r border-border ${tab.id === workspace.activeId ? "border-t-2 border-t-accent bg-accent-hover" : "border-t-2 border-t-transparent"}`}
                title={title}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === workspace.activeId}
                  aria-controls={`conversation-${tab.id}`}
                  id={`tab-${tab.id}`}
                  className="flex min-w-24 max-w-52 items-center gap-2 px-3 py-2 text-left text-xs"
                  onClick={() => select(tab.id, tab.backend)}
                >
                  <span
                    aria-hidden="true"
                    className={`size-1.5 shrink-0 ${tab.status === "running" ? "bg-accent motion-safe:animate-pulse" : tab.status === "waiting" || tab.status === "error" ? "bg-accent" : "bg-muted/40"}`}
                  />
                  <span className="min-w-0 truncate">
                    <span className="block truncate font-medium">{tab.title}</span>
                    <span className="text-[10px] text-muted">
                      {harnessLabel(tab.backend)} · {t(STATUS_LABELS[tab.status])}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={t("harness.closeTitle", { title: tab.title })}
                  disabled={!canClose(tab) || pending > 0}
                  title={
                    !canClose(tab) || pending
                      ? t("harness.cannotCloseWhileRunningOrWithADraftOrQue")
                      : t("harness.closeTabHistoryIsKept")
                  }
                  className="mr-1 px-1 text-muted disabled:opacity-20"
                  onClick={() => workspace.close(tab.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          aria-label={t("harness.openAPastConversation")}
          title={t("harness.openOrRenamePastConversations")}
          disabled={!workspace.ready}
          className="shrink-0 border-l border-border px-2 text-xs hover:bg-accent-hover"
          onClick={() => setHistoryBackend(activeTab?.backend || preferredBackend)}
        >
          {t("harness.history")}
        </button>
        <button
          type="button"
          title={t("harness.newNameConversation", {
            name: harnessLabel(activeTab?.backend || preferredBackend),
          })}
          aria-label={t("harness.newConversation")}
          className="shrink-0 border-l border-border px-3 text-xl hover:bg-accent-hover"
          onClick={() => workspace.open(activeTab?.backend || preferredBackend)}
        >
          +
        </button>
      </div>
      {workspace.error && (
        <p role="alert" className="p-2 text-xs text-accent">
          {workspace.error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {(workspace.ready ? workspace.tabs : []).map((tab) => {
          const Panel = PANELS[tab.backend];
          const incoming = workspace.incoming[tab.id]?.[0];
          return (
            <div
              key={tab.id}
              id={`conversation-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`tab-${tab.id}`}
              className={tab.id === workspace.activeId ? "flex h-full min-h-0 flex-col" : "hidden"}
            >
              {incoming && (
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs">
                  <span className="min-w-0 flex-1 truncate" title={incoming.text}>
                    {incoming.state === "sending"
                      ? t("harness.delivering")
                      : incoming.state === "paused"
                        ? t("harness.pausedAfterARestartCheckTheHistoryThenRe")
                        : incoming.state === "failed"
                          ? t("harness.deliveryFailedCheckTheHistoryThenRetry")
                          : t("harness.deliversOnceConnected")}
                    ：{incoming.text}
                  </span>
                  <button
                    type="button"
                    disabled={incoming.state === "sending" || incoming.state === "pending"}
                    onClick={() => workspace.retry(tab.id)}
                  >
                    {t("harness.retry")}
                  </button>
                  <button
                    type="button"
                    disabled={incoming.state === "sending"}
                    onClick={() => workspace.accept(tab.id, incoming.id)}
                  >
                    {t("harness.cancel")}
                  </button>
                </div>
              )}
              <div className="min-h-0 flex-1">
                <HarnessErrorBoundary name={harnessLabel(tab.backend)}>
                  <Panel
                    {...shared}
                    {...(tab.backend === "opencode" ? opencode : {})}
                    active={visible && tab.id === workspace.activeId}
                    instanceId={tab.id}
                    initialSessionId={tab.sessionId}
                    openSessionIds={workspace.tabs
                      .filter((t) => t.backend === tab.backend)
                      .flatMap((t) => (t.sessionId ? [t.sessionId] : []))}
                    onWorkingChange={() => {}}
                    onConversationChange={(info) => workspace.update(tab.id, info)}
                    onNewConversation={() => workspace.open(tab.backend)}
                    onShowHistory={() => setHistoryBackend(tab.backend)}
                    renamedConversation={
                      renamedConversation?.backend === tab.backend ? renamedConversation : undefined
                    }
                    onOpenConversation={(id, title) => workspace.open(tab.backend, id, title)}
                    incoming={incoming}
                    onIncomingAccepted={(id) => workspace.accept(tab.id, id)}
                    onIncomingState={(id, state) => workspace.deliveryState(tab.id, id, state)}
                  />
                </HarnessErrorBoundary>
              </div>
            </div>
          );
        })}
        {!workspace.tabs.length && (
          <p className="p-4 text-sm text-muted">
            {t("harness.chooseAnAiBackendAboveToStartAConversati")}
          </p>
        )}
      </div>
      {historyBackend && shared.directory && (
        <HistoryDialog
          backend={historyBackend}
          project={shared.directory}
          baseUrl={opencode.baseUrl || "http://localhost:4096"}
          openCodeReady={opencode.daemonStatus === "running"}
          onClose={() => setHistoryBackend(null)}
          onBackend={(backend) => {
            setHistoryBackend(backend);
            workspace.focus(backend);
            onBackendChange(backend);
          }}
          onOpen={(id, title) => {
            workspace.open(historyBackend, id, title);
            setHistoryBackend(null);
            onBackendChange(historyBackend);
          }}
          onRename={(id, title) => {
            setRenamedConversation({ backend: historyBackend, id, title });
            for (const tab of workspace.tabs) {
              if (tab.backend === historyBackend && tab.sessionId === id)
                workspace.update(tab.id, { ...tab, title });
            }
          }}
        />
      )}
    </>
  );
}
