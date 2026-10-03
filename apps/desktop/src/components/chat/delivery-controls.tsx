"use client";
import { CaretDownIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react";
import type { ChatOutbox } from "@/lib/chat/outbox";
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
  const state = outbox.state;
  const perform = (work: Promise<void>) => void work.catch(() => {});
  return (
    <div className="writer-delivery-controls">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
        <label className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <span className="text-muted">执行中发送</span>
          <select
            aria-label="执行中消息发送方式"
            value={mode}
            onChange={(event) => onModeChange(event.target.value as DeliveryMode)}
            className="border border-border bg-background px-1.5 py-1"
          >
            <option value="steer">立即指导 · Steer</option>
            <option value="queue">排队 · Queue</option>
          </select>
        </label>
        <span className="min-w-0 truncate text-muted">
          {busy
            ? mode === "steer"
              ? "发送后接入当前任务"
              : "本轮结束后依次发送"
            : "空闲时直接发送"}
        </span>
      </div>
      {(state.items.length > 0 || state.error) && (
        <details open className="border-t border-border text-xs">
          <summary className="cursor-pointer px-3 py-1.5">
            消息队列 · {state.items.length}
            {state.paused ? " · 已暂停" : ""}
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
                      ? "正在发送 · "
                      : item.state === "uncertain"
                        ? "待核对 · "
                        : ""}
                    {item.raw || "附件消息"}
                    {item.files.length ? ` · ${item.files.length} 个附件` : ""}
                  </summary>
                  <p className="whitespace-pre-wrap break-words py-1">{item.raw}</p>
                  {item.files.map((file) => (
                    <p key={file.url} className="truncate text-muted">
                      附件：{file.filename}
                    </p>
                  ))}
                  {item.selection && <p className="text-muted">已引用 {item.selection.path}</p>}
                </details>
                <button
                  type="button"
                  disabled={item.state === "sending" || index === 0}
                  aria-label={`上移第 ${index + 1} 条消息`}
                  onClick={() => perform(outbox.move(item.id, -1))}
                >
                  <CaretUpIcon className="size-3" />
                </button>
                <button
                  type="button"
                  disabled={item.state === "sending" || index === state.items.length - 1}
                  aria-label={`下移第 ${index + 1} 条消息`}
                  onClick={() => perform(outbox.move(item.id, 1))}
                >
                  <CaretDownIcon className="size-3" />
                </button>
                <button
                  type="button"
                  disabled={item.state === "sending"}
                  aria-label={`移除第 ${index + 1} 条消息`}
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
                    ? "重试并继续队列"
                    : "继续队列"
                  : "暂停队列"}
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
