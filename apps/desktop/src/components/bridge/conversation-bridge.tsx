"use client";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { useConversationBridge } from "@/lib/bridge/use-conversation-bridge";

const labels: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  pending: "等待结果",
  delivered: "已回信",
};
export function ConversationBridge({
  bridge,
}: {
  bridge: ReturnType<typeof useConversationBridge>;
}) {
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
          title={bridge.fullId || "发送首条消息后生成会话 ID"}
          onClick={() => {
            if (bridge.fullId)
              void navigator.clipboard
                .writeText(bridge.fullId)
                .then(() => setCopied(true))
                .catch((cause) => setError(String(cause)));
          }}
          className="min-w-0 flex-1 truncate text-left font-mono hover:text-accent"
        >
          {copied ? "已复制 · " : "ID · "}
          {bridge.fullId || "新会话"}
        </button>
        <label className="flex shrink-0 items-center gap-1">
          <input type="checkbox" checked={bridge.enabled} onChange={bridge.toggle} />
          允许协作
        </label>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 border border-border px-1.5 py-0.5"
        >
          协作 {tasks.length} {expanded ? "▴" : "▾"}
        </button>
      </div>
      {own?.activeJob && (
        <p className="mt-1 text-accent motion-safe:animate-pulse">正在处理委派／自动回信</p>
      )}
      {(error || bridge.error) && (
        <p role="alert" className="mt-1 text-red-600">
          {error || bridge.error}
        </p>
      )}
      {expanded && (
        <div className="mt-2 max-h-64 space-y-2 overflow-auto">
          <p className="text-muted">
            复制另一边的完整 ID 告诉 AI，即可委派；任务结束会自动回信。目标需先在 Writer 中打开。
          </p>
          {bridge.snapshot.conversations
            .filter((s) => s.id !== bridge.fullId)
            .map((s) => (
              <div key={s.id} className="border border-border p-2">
                <div className="flex justify-between">
                  <span>
                    {s.title || s.backend} · {s.busy || s.activeJob ? "运行中" : "空闲"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(s.id)
                        .catch((cause) => setError(String(cause)))
                    }
                  >
                    复制 ID
                  </button>
                </div>
                <code className="break-all">{s.id}</code>
              </div>
            ))}
          {tasks.map((task) => (
            <details key={task.id} className="border border-border p-2">
              <summary className="cursor-pointer">
                {labels[task.status] || task.status} · 回信：
                {labels[task.callback] || task.callback}
                <span className="ml-1 text-muted">{task.prompt.slice(0, 45)}</span>
              </summary>
              <p className="mt-2 whitespace-pre-wrap">{task.prompt}</p>
              <pre className="mt-2 whitespace-pre-wrap break-words text-muted">
                {task.result || "等待完成，结果会自动返回原会话。"}
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
                  取消排队
                </button>
              )}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
