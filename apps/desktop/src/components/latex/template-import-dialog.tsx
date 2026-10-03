"use client";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
export function TemplateImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (path: string) => Promise<void>;
}) {
  const [source, setSource] = useState("");
  const [parent, setParent] = useState("");
  const [name, setName] = useState("paper-template");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (directory: boolean) => {
    try {
      const path = await open({
        directory,
        multiple: false,
        title: directory ? "选择完整模板文件夹" : "选择 LaTeX 模板 ZIP",
        ...(!directory ? { filters: [{ name: "ZIP 模板", extensions: ["zip"] }] } : {}),
      });
      if (typeof path === "string") {
        setSource(path);
        setName(
          path
            .replace(/\\/g, "/")
            .split("/")
            .pop()
            ?.replace(/\.zip$/i, "") || "paper-template",
        );
      }
    } catch (cause) {
      setError(String(cause));
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="导入 LaTeX 模板"
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black/40 p-6"
    >
      <div className="w-full max-w-xl space-y-4 border border-border bg-background p-5 text-sm">
        <div className="flex justify-between">
          <strong>导入 LaTeX 模板</strong>
          <button type="button" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="text-xs text-muted">
          选择下载好的完整模板（例如 ICLR 模板），将
          .tex、.sty、.cls、.bst、图片等复制到一个新项目，不覆盖已有论文。
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose(false)}
            className="border border-border px-3 py-2"
          >
            选择 ZIP
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose(true)}
            className="border border-border px-3 py-2"
          >
            选择文件夹
          </button>
        </div>
        <p className="break-all text-xs">{source || "尚未选择模板"}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void open({ directory: true, multiple: false, title: "选择新项目存放目录" })
              .then((value) => {
                if (typeof value === "string") setParent(value);
              })
              .catch((cause) => setError(String(cause)))
          }
          className="border border-border px-3 py-2"
        >
          选择存放位置
        </button>
        <p className="break-all text-xs">{parent || "尚未选择存放目录"}</p>
        <label className="block">
          新项目文件夹名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            className="mt-1 w-full border border-border bg-background p-2"
          />
        </label>
        {error && (
          <p role="alert" className="whitespace-pre-wrap text-xs text-red-600">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={busy || !source || !parent || !name.trim()}
          onClick={() => {
            setBusy(true);
            setError(null);
            void invoke<string>("latex_import_template", { source, parent, name: name.trim() })
              .then(onImported)
              .then(onClose)
              .catch((cause) => setError(String(cause)))
              .finally(() => setBusy(false));
          }}
          className="border border-foreground bg-foreground px-4 py-2 text-background disabled:opacity-40"
        >
          {busy ? "正在导入…" : "导入并打开新项目"}
        </button>
      </div>
    </div>
  );
}
