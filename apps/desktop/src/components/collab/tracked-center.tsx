"use client";
/**
 * Track changes for a folder linked to a server project, as the web's Track changes button
 * offers it: on for everyone or for this member, the open file's changes counted, and all of
 * them accepted or rejected at once (one at a time from the editor's hover card). While on,
 * what is saved here reaches the server as tracked insertions and deletions.
 */
import type { ShownChange } from "@lmms-lab/sync";
import { ask } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import type { FolderSyncControls } from "@/lib/collab/use-folder-sync";
import { useI18n } from "@/lib/i18n";

export function TrackedCenter({
  sync,
  path,
  changes,
}: {
  sync: FolderSyncControls;
  path?: string;
  changes: ShownChange[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const tracking = sync.tracking;
  if (!sync.link || !tracking) return null;
  const on = tracking.everyone || tracking.mine;
  const toggle = (change: { everyone?: boolean; mine?: boolean }) =>
    void sync.setTracking(change).catch((cause) => setError(String(cause)));
  const decideAll = async (accept: boolean) => {
    if (!path || !changes.length) return;
    if (
      !accept &&
      !(await ask(t("collab.tracked.confirmRejectAll", { count: changes.length }), {
        title: t("collab.tracked.rejectAll"),
        kind: "warning",
      }))
    )
      return;
    sync.decide(path, null, accept);
  };
  return (
    <div className="relative" ref={box}>
      <span aria-hidden="true" className="mx-1 inline-block h-4 w-px bg-border align-middle" />
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t("collab.tracked.title")}
        className={`border px-2 py-1 ${on ? "border-foreground" : "border-border"}`}
      >
        {on ? t("collab.tracked.on") : t("collab.tracked.button")}
        {changes.length > 0 && ` · ${changes.length}`}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-80 space-y-2 border border-border bg-background p-3 text-xs shadow-lg">
          <p className="leading-5 text-muted">{t("collab.tracked.lead")}</p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={tracking.everyone}
              disabled={!tracking.canEdit}
              onChange={(e) => toggle({ everyone: e.target.checked })}
            />
            <span>
              {t("collab.tracked.everyone")}
              <span className="block text-muted">{t("collab.tracked.everyoneHint")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={tracking.mine}
              disabled={!tracking.canEdit || tracking.everyone}
              onChange={(e) => toggle({ mine: e.target.checked })}
            />
            <span>
              {t("collab.tracked.mine")}
              <span className="block text-muted">{t("collab.tracked.mineHint")}</span>
            </span>
          </label>
          <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
            <span className="text-muted">
              {path && changes.length
                ? t("collab.tracked.inFile", { count: changes.length })
                : t("collab.tracked.none")}
            </span>
            {tracking.canEdit && changes.length > 0 && (
              <span className="flex gap-1">
                <button
                  type="button"
                  className="border border-border px-2 py-0.5"
                  onClick={() => void decideAll(true)}
                >
                  {t("collab.tracked.acceptAll")}
                </button>
                <button
                  type="button"
                  className="border border-border px-2 py-0.5"
                  onClick={() => void decideAll(false)}
                >
                  {t("collab.tracked.rejectAll")}
                </button>
              </span>
            )}
          </div>
          {!tracking.canEdit && <p className="text-muted">{t("collab.tracked.readOnly")}</p>}
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
