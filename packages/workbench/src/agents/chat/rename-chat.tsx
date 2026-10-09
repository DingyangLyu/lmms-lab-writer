"use client";

import { CheckIcon, PencilSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useWorkbenchI18n as useI18n } from "../../i18n";

export function RenameChat({
  name,
  onRename,
}: {
  name: string;
  onRename: (name: string) => Promise<void>;
}) {
  const { t } = useI18n();
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
        aria-label={t("chat.renameConversationName", { name })}
        title={t("chat.renameConversation")}
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
          aria-label={t("chat.newConversationName")}
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
          aria-label={t("chat.saveConversationName")}
          title={t("chat.saveName")}
          disabled={busy || !draft.trim()}
          onClick={() => void save()}
          className="p-1 text-accent disabled:opacity-40"
        >
          <CheckIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t("chat.cancelRenaming")}
          title={t("chat.cancel")}
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
