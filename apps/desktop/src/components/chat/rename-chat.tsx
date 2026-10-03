"use client";

import { CheckIcon, PencilSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";

export function RenameChat({
  name,
  onRename,
}: {
  name: string;
  onRename: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onRename(draft.trim());
      setEditing(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!editing)
    return (
      <button
        type="button"
        aria-label={`重命名对话：${name}`}
        title="重命名对话"
        className="shrink-0 p-2 text-muted hover:text-accent"
        onClick={() => {
          setDraft(name);
          setError("");
          setEditing(true);
        }}
      >
        <PencilSimpleIcon className="size-3.5" />
      </button>
    );
  return (
    <div className="min-w-0 flex-1 p-1.5">
      <div className="flex items-center gap-1">
        <input
          aria-label="对话新名称"
          value={draft}
          maxLength={120}
          disabled={busy}
          ref={(node) => {
            node?.focus();
          }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-xs outline-none focus:border-accent"
        />
        <button
          type="button"
          aria-label="保存对话名称"
          title="保存名称"
          disabled={busy || !draft.trim()}
          onClick={() => void save()}
          className="p-1 text-accent disabled:opacity-40"
        >
          <CheckIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="取消重命名"
          title="取消"
          disabled={busy}
          onClick={() => setEditing(false)}
          className="p-1 text-muted"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
