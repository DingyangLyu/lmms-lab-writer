"use client";
import type { SyncState } from "@lmms-lab/sync";
import { useEffect, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { type CollabAccount, listAccounts } from "@/lib/collab/accounts";
import { RUNNER_HARNESSES, type RunnerHarness, type SharedRunner } from "@/lib/collab/runner";
import type { FolderSyncControls } from "@/lib/collab/use-folder-sync";
import { type MessageKey, useI18n } from "@/lib/i18n";
import { pathSync } from "@/lib/path";

const ROLES = ["owner", "editor", "commenter", "viewer"];
export const roleKey = (role: string | null | undefined) =>
  `collab.role.${role && ROLES.includes(role) ? role : "viewer"}` as MessageKey;

const DOT: Record<SyncState, string> = {
  connecting: "bg-amber-500",
  syncing: "bg-amber-500",
  synced: "bg-green-600",
  offline: "bg-red-600",
  paused: "bg-red-600",
  "signed-out": "bg-red-600",
  stopped: "bg-muted-foreground",
};

/** Header button with the sync state; the dialog links, unlinks and resolves a pause. */
export function SyncPanel({
  sync,
  runner,
  projectPath,
  onOpenFromServer,
  onOpenSettings,
}: {
  sync: FolderSyncControls;
  runner: SharedRunner;
  projectPath: string;
  onOpenFromServer: () => void;
  onOpenSettings: () => void;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<CollabAccount[]>([]);
  const [server, setServer] = useState("");
  const [name, setName] = useState(() => pathSync.basename(projectPath));
  const [busy, setBusy] = useState(false);
  const { link, status, missing } = sync;
  const state: SyncState | null = link ? (status?.state ?? "connecting") : null;

  useEffect(() => {
    if (!open || link) return;
    listAccounts()
      .then((list) => {
        setAccounts(list);
        setServer((current) => current || list[0]?.server || "");
      })
      .catch(() => setAccounts([]));
  }, [open, link]);

  const act = (action: () => Promise<void>) => {
    setBusy(true);
    void action()
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button
        type="button"
        className="flex shrink-0 items-center gap-1.5 border border-border px-2 py-1 text-xs hover:border-foreground"
        onClick={() => setOpen(true)}
      >
        {state && <span aria-hidden className={`size-1.5 ${DOT[state]}`} />}
        {state ? t(`collab.status.${state}`) : t("collab.status.unlinked")}
        {!!status?.pending && state === "syncing" && (
          <span className="text-muted-foreground">
            · {t("collab.pending", { count: status.pending })}
          </span>
        )}
      </button>
      {open && (
        <div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/30 p-5">
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t("collab.panel.title")}
            className="w-full max-w-lg space-y-3 border-2 border-foreground bg-background p-5 text-sm shadow-[4px_4px_0_0_var(--foreground)]"
          >
            <h2 className="text-base font-bold">{t("collab.panel.title")}</h2>
            {link ? (
              <>
                <p>{t("collab.panel.linked", { server: link.server, name: link.name })}</p>
                {status?.role && (
                  <p className="text-xs text-muted-foreground">
                    {t("collab.panel.role", { role: t(roleKey(status.role)) })}
                    {!["owner", "editor"].includes(status.role) &&
                      ` ${t("collab.panel.readOnlyHint")}`}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {status?.lastSynced
                    ? t("collab.panel.lastSynced", {
                        time: new Date(status.lastSynced).toLocaleString(
                          locale === "zh" ? "zh-CN" : "en",
                        ),
                      })
                    : t("collab.panel.never")}
                </p>
                {state === "signed-out" && (
                  <p className="border border-red-600 p-2 text-xs text-red-600">
                    {t("collab.panel.signedOutHint")}
                  </p>
                )}
                {status?.error && state !== "signed-out" && (
                  <p className="text-xs text-red-600 break-words">{status.error}</p>
                )}
                {state === "paused" && missing > 0 && (
                  <div className="space-y-2 border border-red-600 p-3">
                    <p className="text-xs">{t("collab.panel.pausedHint", { count: missing })}</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="border-2 border-foreground px-3 py-1 text-xs"
                        onClick={() => sync.resolveMissing("restore")}
                      >
                        {t("collab.panel.restore")}
                      </button>
                      <button
                        type="button"
                        className="border border-red-600 px-3 py-1 text-xs text-red-600"
                        onClick={() => sync.resolveMissing("delete")}
                      >
                        {t("collab.panel.confirmDelete")}
                      </button>
                    </div>
                  </div>
                )}
                {status?.role === "owner" && <RunnerSection runner={runner} act={act} />}
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    className="border border-border px-3 py-1.5 hover:border-foreground"
                    onClick={() =>
                      act(async () => {
                        const { open: openUrl } = await import("@tauri-apps/plugin-shell");
                        await openUrl(
                          `${link.server}/?project=${encodeURIComponent(link.project)}`,
                        );
                      })
                    }
                  >
                    {t("collab.panel.openWeb")}
                  </button>
                  {state === "signed-out" && (
                    <button
                      type="button"
                      className="border border-border px-3 py-1.5 hover:border-foreground"
                      onClick={() => {
                        setOpen(false);
                        onOpenSettings();
                      }}
                    >
                      {t("collab.panel.openSettings")}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    className="border border-border px-3 py-1.5 hover:border-foreground disabled:opacity-50"
                    onClick={() =>
                      act(async () => {
                        const { ask } = await import("@tauri-apps/plugin-dialog");
                        if (await ask(t("collab.panel.unlinkConfirm"), { kind: "warning" }))
                          await sync.unlink();
                      })
                    }
                  >
                    {t("collab.panel.unlink")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>{t("collab.panel.notLinked")}</p>
                {accounts.length ? (
                  <form
                    className="space-y-2 border border-border p-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      act(async () => {
                        const created = await sync.upload(server, name.trim() || "Writer");
                        toast(t("collab.panel.uploaded", { name: created.name }), "success");
                      });
                    }}
                  >
                    {accounts.length > 1 && (
                      <label className="block text-xs">
                        {t("collab.panel.server")}
                        <select
                          value={server}
                          onChange={(e) => setServer(e.target.value)}
                          className="mt-1 w-full border border-border bg-background p-2 text-sm"
                        >
                          {accounts.map((a) => (
                            <option key={a.server} value={a.server}>
                              {a.server}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="block text-xs">
                      {t("collab.panel.projectName")}
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={120}
                        className="mt-1 w-full border border-border bg-background p-2 text-sm"
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={busy || !server}
                      className="border-2 border-foreground px-3 py-1.5 disabled:opacity-50"
                    >
                      {busy ? t("collab.panel.uploading") : t("collab.panel.upload")}
                    </button>
                  </form>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("collab.panel.noAccount")}{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => {
                        setOpen(false);
                        onOpenSettings();
                      }}
                    >
                      {t("collab.panel.openSettings")}
                    </button>
                  </p>
                )}
                <button
                  type="button"
                  className="border border-border px-3 py-1.5 hover:border-foreground"
                  onClick={() => {
                    setOpen(false);
                    onOpenFromServer();
                  }}
                >
                  {t("collab.panel.openFromServer")}
                </button>
              </>
            )}
            <p className="text-xs text-muted-foreground">{t("collab.panel.syncFolderHint")}</p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="border border-border px-4 py-1.5 hover:border-foreground"
              >
                {t("common.close")}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function RunnerSection({
  runner,
  act,
}: {
  runner: SharedRunner;
  act: (action: () => Promise<void>) => void;
}) {
  const { t } = useI18n();
  const [chosen, setChosen] = useState<RunnerHarness[]>(["codex", "claude", "opencode"]);
  const on = !!runner.harnesses?.length;
  const { activity } = runner;
  return (
    <section className="space-y-2 border border-border p-3">
      <h3 className="text-xs font-bold">{t("collab.runner.title")}</h3>
      <p className="text-xs text-muted-foreground leading-5">{t("collab.runner.hint")}</p>
      <fieldset className="flex flex-wrap gap-3 text-xs" disabled={on}>
        <legend className="sr-only">{t("collab.runner.pick")}</legend>
        {RUNNER_HARNESSES.map((h) => (
          <label key={h.id} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={on ? !!runner.harnesses?.includes(h.id) : chosen.includes(h.id)}
              onChange={(e) =>
                setChosen((list) =>
                  e.target.checked ? [...list, h.id] : list.filter((x) => x !== h.id),
                )
              }
            />
            {h.label}
          </label>
        ))}
      </fieldset>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {activity.state === "running"
            ? t("collab.runner.running", { prompt: activity.prompt ?? "" })
            : activity.state === "error"
              ? t("collab.runner.error", { message: activity.message ?? "" })
              : activity.state === "idle"
                ? activity.completed
                  ? t("collab.runner.completed", { count: activity.completed })
                  : t("collab.runner.idle")
                : ""}
        </p>
        <button
          type="button"
          disabled={!on && !chosen.length}
          className="shrink-0 border border-border px-3 py-1 text-xs hover:border-foreground disabled:opacity-50"
          onClick={() => act(() => (on ? runner.disable() : runner.enable(chosen)))}
        >
          {on ? t("collab.runner.disable") : t("collab.runner.enable")}
        </button>
      </div>
    </section>
  );
}
