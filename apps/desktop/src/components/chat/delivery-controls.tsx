"use client";
import { CaretDownIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react";
import type { ChatOutbox } from "@/lib/chat/outbox";
import { useI18n } from "@/lib/i18n";
export type DeliveryMode = "steer" | "queue";
export function DeliveryControls({
  mode,
  onModeChange,
  busy,
  outbox,
}: {
  mode: DeliveryMode;
  onModeChange: (mode: DeliveryMode) => void;
  busy: boolean;
  outbox: ChatOutbox;
}) {
  const { t } = useI18n();
  const state = outbox.state;
  const perform = (work: Promise<void>) => void work.catch(() => {});
  return (
    <div className="writer-delivery-controls">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
        <label className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <span className="text-muted">{t("chat.whileRunning")}</span>
          <select
            aria-label={t("chat.howToSendWhileATaskRuns")}
            value={mode}
            onChange={(event) => onModeChange(event.target.value as DeliveryMode)}
            className="border border-border bg-background px-1.5 py-1"
          >
            <option value="steer">{t("chat.steerNow")}</option>
            <option value="queue">{t("chat.queue")}</option>
          </select>
        </label>
        <span className="min-w-0 truncate text-muted">
          {busy
            ? mode === "steer"
              ? t("chat.joinsTheRunningTask")
              : t("chat.sentInOrderAfterThisTurn")
            : t("chat.sentImmediatelyWhenIdle")}
        </span>
      </div>
      {(state.items.length > 0 || state.error) && (
        <details open className="border-t border-border text-xs">
          <summary className="cursor-pointer px-3 py-1.5">
            {t("chat.messageQueueCount", { count: state.items.length })}
            {state.paused ? t("chat.paused") : ""}
          </summary>
          <div className="max-h-24 overflow-y-auto px-3 pb-2">
            {state.error && (
              <p role="alert" className="mb-1 text-red-600">
                {state.error}
              </p>
            )}
            {state.items.map((item, index) => (
              <div key={item.id} className="flex items-center gap-1 border-t border-border py-1">
                <span className="text-muted">{index + 1}</span>
                <details className="min-w-0 flex-1">
                  <summary className="cursor-pointer truncate" title={item.raw}>
                    {item.state === "sending"
                      ? t("chat.sending")
                      : item.state === "uncertain"
                        ? t("chat.toCheck")
                        : ""}
                    {item.raw || t("chat.attachmentMessage")}
                    {item.files.length
                      ? t("chat.countCountAttachmentAttachments", { count: item.files.length })
                      : ""}
                  </summary>
                  <p className="whitespace-pre-wrap break-words py-1">{item.raw}</p>
                  {item.files.map((file) => (
                    <p key={file.url} className="truncate text-muted">
                      {t("chat.attachmentName", { name: file.filename })}
                    </p>
                  ))}
                  {item.selection && (
                    <p className="text-muted">
                      {t("chat.quotingPath", { path: item.selection.path })}
                    </p>
                  )}
                </details>
                <button
                  type="button"
                  disabled={item.state === "sending" || index === 0}
                  aria-label={t("chat.moveMessageNUp", { n: index + 1 })}
                  onClick={() => perform(outbox.move(item.id, -1))}
                >
                  <CaretUpIcon className="size-3" />
                </button>
                <button
                  type="button"
                  disabled={item.state === "sending" || index === state.items.length - 1}
                  aria-label={t("chat.moveMessageNDown", { n: index + 1 })}
                  onClick={() => perform(outbox.move(item.id, 1))}
                >
                  <CaretDownIcon className="size-3" />
                </button>
                <button
                  type="button"
                  disabled={item.state === "sending"}
                  aria-label={t("chat.removeMessageN", { n: index + 1 })}
                  onClick={() => perform(outbox.remove(item.id))}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
            {state.items.length > 0 && (
              <button
                type="button"
                className="mt-1 border border-border px-2 py-1"
                onClick={() => perform(state.paused ? outbox.resume() : outbox.pause())}
              >
                {state.paused
                  ? state.items.some((item) => item.state === "uncertain")
                    ? t("chat.retryAndResumeTheQueue")
                    : t("chat.resumeTheQueue")
                  : t("chat.pauseTheQueue")}
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
