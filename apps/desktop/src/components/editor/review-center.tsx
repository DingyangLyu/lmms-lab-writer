"use client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import type { SaveManager } from "@/lib/editor/save-manager";
import { useAnnotations } from "@/lib/pdf/annotation-context";

type Summary = {
  id: string;
  actor: string;
  startedAt: number;
  finishedAt: number | null;
  pending: number;
  files: number;
};
type Part = { id: number; before: string; after: string; changed: boolean; status: string };
type Review = Summary & {
  revision: number;
  version: string;
  annotations: string[];
  changes: { path: string; before: string; after: string; parts: Part[] }[];
  decisions: { id: string; path: string; part: number; from: string; to: string; at: number }[];
};
export function ReviewCenter({
  project,
  manager,
  agentBusy,
  onOpen,
}: {
  project: string;
  manager: SaveManager;
  agentBusy: boolean;
  onOpen: (path: string) => void;
}) {
  const annotations = useAnnotations();
  const [open, setOpen] = useState(false),
    [summaries, setSummaries] = useState<Summary[]>([]),
    [review, setReview] = useState<Review | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const reload = useCallback(
    async () => setSummaries(await invoke<Summary[]>("review_list", { project })),
    [project],
  );
  useEffect(() => {
    let stop: (() => void) | undefined,
      disposed = false;
    void reload().catch((e) => setError(String(e)));
    void listen<{ project: string; error?: string }>("writer://reviews-changed", ({ payload }) => {
      if (payload.project === project) {
        void reload().catch((e) => setError(String(e)));
        if (payload.error) setError(payload.error);
      }
    }).then((s) => {
      if (disposed) s();
      else stop = s;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [project, reload]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const decide = async (file: string, part: number, status: string) => {
    if (!review) return;
    await manager.flushAll(project);
    const result = await invoke<Review>("review_decide", {
      project,
      id: review.id,
      expectedRevision: review.revision,
      file,
      part,
      status,
    });
    setReview(result);
    await manager.synchronize(project, [file]);
    await reload();
  };
  return (
    <>
      <button
        type="button"
        className="border border-border px-2 py-1 text-xs"
        title={error || undefined}
        onClick={() => {
          setOpen(true);
          void run(reload);
        }}
      >
        修改审阅 {summaries.reduce((n, s) => n + s.pending, 0)}
        {error && <span className="ml-1 text-red-600">!</span>}
      </button>
      {open && (
        <div className="fixed inset-0 z-[175] flex items-center justify-center bg-black/30 p-5">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="AI 修改审阅"
            className="flex h-[86vh] w-full max-w-6xl flex-col border border-border bg-background shadow-xl"
          >
            <header className="flex items-center justify-between border-b border-border p-3">
              <strong>修改审阅</strong>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setReview(null);
                }}
              >
                关闭
              </button>
            </header>
            <p className="border-b border-border p-3 text-xs text-muted">
              原生 Agent
              的修改已写入工作区；接受表示保留，拒绝会安全撤回该项，撤销决定可重新核对。任务期间在编辑器和文献库中的人工保存会自动排除；同时运行的其他
              Agent 或外部程序的修改仍可能计入。图片、PDF 及超过 2 MB 的文本请在 Git
              版本中核对。运行中暂不接受或撤回。
            </p>
            {error && (
              <p role="alert" className="whitespace-pre-wrap p-3 text-sm text-red-600">
                {error}
              </p>
            )}
            <div className="flex min-h-0 flex-1">
              <aside className="w-64 shrink-0 overflow-auto border-r border-border p-2">
                {summaries.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    disabled={busy}
                    className={`mb-2 w-full border p-2 text-left text-xs ${review?.id === s.id ? "border-foreground" : "border-border"}`}
                    onClick={() =>
                      void run(async () =>
                        setReview(await invoke<Review>("review_read", { project, id: s.id })),
                      )
                    }
                  >
                    <strong className="block truncate">{s.actor}</strong>
                    <span>{new Date(s.startedAt).toLocaleString()}</span>
                    <span className="block">
                      {s.finishedAt
                        ? `${s.files} 个文件 · ${s.pending} 项待审阅`
                        : "任务记录中 / 待恢复"}
                    </span>
                  </button>
                ))}
                {!summaries.length && (
                  <p className="p-3 text-sm text-muted">
                    下一次 Agent 任务会自动记录修改前后版本。
                  </p>
                )}
              </aside>
              <div className="min-w-0 flex-1 overflow-auto p-3">
                {review && (
                  <>
                    {!review.finishedAt && (
                      <button
                        type="button"
                        disabled={busy || agentBusy}
                        onClick={() =>
                          void run(async () => {
                            await invoke("review_finalize", { project, id: review.id });
                            setReview(
                              await invoke<Review>("review_read", { project, id: review.id }),
                            );
                            await reload();
                          })
                        }
                        className="mb-3 border border-border p-2 text-sm"
                      >
                        任务已结束：恢复并生成审阅
                      </button>
                    )}
                    {!!review.annotations.length && (
                      <div className="mb-3 flex flex-wrap gap-2 text-xs">
                        <span>任务开始时待处理的批注：</span>
                        {review.annotations.map((id) => (
                          <button
                            type="button"
                            key={id}
                            className="max-w-52 truncate border border-border px-2 py-1"
                            onClick={() => {
                              setOpen(false);
                              setReview(null);
                              annotations?.focusAnnotation(id);
                            }}
                          >
                            {annotations?.items.find((note) => note.id === id)?.comment || id}
                          </button>
                        ))}
                        <p className="w-full text-muted">
                          拒绝修改后，可打开相关批注核对并重新标为待处理。
                        </p>
                      </div>
                    )}
                    {review.changes.map((c) => (
                      <article key={c.path} className="mb-4 border border-border">
                        <header className="flex items-center justify-between border-b border-border p-2 text-sm">
                          <strong>{c.path}</strong>
                          <button
                            type="button"
                            onClick={() => {
                              onOpen(c.path);
                              setOpen(false);
                              setReview(null);
                            }}
                          >
                            打开文件
                          </button>
                        </header>
                        {c.parts.map(
                          (p, i) =>
                            p.changed && (
                              <div key={`${c.path}:${p.id}`} className="border-b border-border p-3">
                                <div className="mb-2 flex items-center justify-between text-xs">
                                  <span
                                    className={
                                      p.status === "accepted"
                                        ? "text-green-700"
                                        : p.status === "rejected"
                                          ? "text-red-600"
                                          : ""
                                    }
                                  >
                                    {p.status === "accepted"
                                      ? "✓ 已接受"
                                      : p.status === "rejected"
                                        ? "已拒绝"
                                        : "待审阅"}
                                  </span>
                                  <div className="flex gap-3">
                                    <button
                                      type="button"
                                      disabled={busy || agentBusy || p.status === "accepted"}
                                      onClick={() => void run(() => decide(c.path, i, "accepted"))}
                                    >
                                      接受
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busy || agentBusy || p.status === "rejected"}
                                      onClick={() => void run(() => decide(c.path, i, "rejected"))}
                                    >
                                      拒绝 / 撤回
                                    </button>
                                    {p.status !== "pending" && (
                                      <button
                                        type="button"
                                        disabled={busy || agentBusy}
                                        onClick={() => void run(() => decide(c.path, i, "pending"))}
                                      >
                                        撤销决定
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                  <pre className="overflow-auto whitespace-pre-wrap border border-red-200 bg-red-50/50 p-2 text-foreground">
                                    {p.before || "（新增）"}
                                  </pre>
                                  <pre className="overflow-auto whitespace-pre-wrap border border-green-200 bg-green-50/50 p-2 text-foreground">
                                    {p.after || "（删除）"}
                                  </pre>
                                </div>
                              </div>
                            ),
                        )}
                      </article>
                    ))}
                    <details className="text-xs">
                      <summary>审阅决定历史 · {review.decisions.length}</summary>
                      {review.decisions.map((d) => (
                        <p key={d.id}>
                          {new Date(d.at).toLocaleString()} · {d.path} · {d.from} → {d.to}
                        </p>
                      ))}
                    </details>
                  </>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
