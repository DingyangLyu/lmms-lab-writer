"use client";
import { useState } from "react";
import type { SaveManager } from "@/lib/editor/save-manager";
export function CollaborationButton({
  project,
  manager,
}: {
  project: string;
  manager: SaveManager;
}) {
  const [open, setOpen] = useState(false),
    [url, setUrl] = useState(() =>
      typeof window === "undefined"
        ? "http://127.0.0.1:8787"
        : localStorage.getItem("writer-collaboration-url") || "http://127.0.0.1:8787",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        className="border border-border px-2 py-1 text-xs"
        onClick={() => setOpen(true)}
      >
        多人协作
      </button>
      {open && (
        <div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/30 p-5">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="打开多人协作"
            className="w-full max-w-lg space-y-3 border border-border bg-background p-5 text-sm"
          >
            <h2 className="font-medium">打开多人写作空间</h2>
            <p className="text-muted">
              连接你部署的 Writer
              协作服务。登录后可创建项目、导入完整论文文件夹，再邀请合作者共同编辑。当前本地文件会先保存；不会自动上传。
            </p>
            <label className="block">
              服务地址
              <input
                aria-label="协作服务地址"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="mt-1 w-full border border-border bg-background p-2"
              />
            </label>
            {error && (
              <p role="alert" className="text-red-600">
                {error}
              </p>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void (async () => {
                    const parsed = new URL(url);
                    if (
                      !["http:", "https:"].includes(parsed.protocol) ||
                      parsed.username ||
                      parsed.password
                    )
                      throw new Error("请输入 HTTP/HTTPS 地址，不要在地址中放账号或密码。");
                    if (
                      parsed.protocol === "http:" &&
                      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
                    )
                      throw new Error("远程协作请使用 HTTPS；本机测试可使用 HTTP。");
                    await manager.flushAll(project);
                    localStorage.setItem("writer-collaboration-url", parsed.origin);
                    const { open } = await import("@tauri-apps/plugin-shell");
                    await open(parsed.origin);
                    setOpen(false);
                  })()
                    .catch((e) => setError(String(e)))
                    .finally(() => setBusy(false));
                }}
                className="border border-foreground px-3 py-2"
              >
                保存并打开协作服务
              </button>
              <button type="button" disabled={busy} onClick={() => setOpen(false)}>
                取消
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
