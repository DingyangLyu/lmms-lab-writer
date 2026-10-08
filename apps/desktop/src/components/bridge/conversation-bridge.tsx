"use client";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { useConversationBridge } from "@/lib/bridge/use-conversation-bridge";
import { type MessageKey, useI18n } from "@/lib/i18n";

const labels: Record<string, MessageKey> = {
  queued: "bridge.queued",
  running: "bridge.running",
  completed: "bridge.completed",
  failed: "bridge.failed",
  cancelled: "bridge.cancelled",
  interrupted: "bridge.interrupted",
  pending: "bridge.waitingForTheResult",
  delivered: "bridge.reportedBack",
};
export function ConversationBridge({
  bridge,
}: {
  bridge: ReturnType<typeof useConversationBridge>;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tasks = bridge.snapshot.tasks.filter(
    (t) => t.from === bridge.fullId || t.to === bridge.fullId,
  );
  const own = bridge.snapshot.conversations.find((s) => s.id === bridge.fullId);
  return (
    <div className="shrink-0 border-b border-border bg-surface-secondary px-3 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          disabled={!bridge.fullId}
          title={bridge.fullId || t("bridge.theSessionIdAppearsAfterTheFirstMessage")}
          onClick={() => {
            if (bridge.fullId)
              void navigator.clipboard
                .writeText(bridge.fullId)
                .then(() => setCopied(true))
                .catch((cause) => setError(String(cause)));
          }}
          className="min-w-0 flex-1 truncate text-left font-mono hover:text-accent"
        >
          {copied ? t("bridge.copied") : "ID · "}
          {bridge.fullId || t("bridge.newSession")}
        </button>
        <label className="flex shrink-0 items-center gap-1">
          <input type="checkbox" checked={bridge.enabled} onChange={bridge.toggle} />
          {t("bridge.allowDelegation")}
        </label>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 border border-border px-1.5 py-0.5"
        >
          {t("bridge.delegationsCount", { count: tasks.length })} {expanded ? "▴" : "▾"}
        </button>
      </div>
      {own?.activeJob && (
        <p className="mt-1 text-accent motion-safe:animate-pulse">
          {t("bridge.handlingDelegationsAutomaticReplies")}
        </p>
      )}
      {(error || bridge.error) && (
        <p role="alert" className="mt-1 text-red-600">
          {error || bridge.error}
        </p>
      )}
      {expanded && (
        <div className="mt-2 max-h-64 space-y-2 overflow-auto">
          <p className="text-muted">{t("bridge.giveTheAiTheOtherConversationSFullIdToDe")}</p>
          {bridge.snapshot.conversations
            .filter((s) => s.id !== bridge.fullId)
            .map((s) => (
              <div key={s.id} className="border border-border p-2">
                <div className="flex justify-between">
                  <span>
                    {s.title || s.backend} ·{" "}
                    {s.busy || s.activeJob ? t("bridge.running2") : t("bridge.idle")}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(s.id)
                        .catch((cause) => setError(String(cause)))
                    }
                  >
                    {t("bridge.copyId")}
                  </button>
                </div>
                <code className="break-all">{s.id}</code>
              </div>
            ))}
          {tasks.map((task) => (
            <details key={task.id} className="border border-border p-2">
              <summary className="cursor-pointer">
                {t("bridge.statusReplyCallback", {
                  status: labels[task.status] ? t(labels[task.status] as MessageKey) : task.status,
                  callback: labels[task.callback]
                    ? t(labels[task.callback] as MessageKey)
                    : task.callback,
                })}
                <span className="ml-1 text-muted">{task.prompt.slice(0, 45)}</span>
              </summary>
              <p className="mt-2 whitespace-pre-wrap">{task.prompt}</p>
              <pre className="mt-2 whitespace-pre-wrap break-words text-muted">
                {task.result || t("bridge.waitingTheResultReturnsToTheOriginalConv")}
              </pre>
              {(task.status === "queued" || task.callback === "queued") && (
                <button
                  type="button"
                  onClick={() =>
                    void invoke("writer_cancel_queued_task", { id: task.id }).catch((cause) =>
                      setError(String(cause)),
                    )
                  }
                  className="mt-2 border border-border px-2 py-1"
                >
                  {t("bridge.cancel")}
                </button>
              )}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
