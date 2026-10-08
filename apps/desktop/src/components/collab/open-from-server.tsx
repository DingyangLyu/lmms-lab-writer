"use client";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  type CollabAccount,
  listAccounts,
  rememberFolder,
  type ServerProject,
  serverRequest,
  setLink,
} from "@/lib/collab/accounts";
import { useI18n } from "@/lib/i18n";
import { ServerAccounts } from "./server-accounts";
import { roleKey } from "./sync-panel";

/**
 * Picks a project on a signed-in server, creates a folder named after it where the user
 * chooses, links the two and opens the folder; the sync then downloads every file.
 */
export function OpenFromServer({
  initial,
  onClose,
  onOpened,
}: {
  /** From a web page link: preselects this server and project. */
  initial?: { server: string; project: string } | null;
  onClose: () => void;
  onOpened: (path: string) => void;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<CollabAccount[] | null>(null);
  const [server, setServer] = useState(initial?.server ?? "");
  const [projects, setProjects] = useState<ServerProject[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadAccounts = useCallback(
    () =>
      listAccounts()
        .then((list) => {
          setAccounts(list);
          setServer((current) =>
            list.some((a) => a.server === current) ? current : (list[0]?.server ?? ""),
          );
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);
  useEffect(() => {
    setProjects(null);
    if (!server) return;
    serverRequest<ServerProject[]>(server, "GET", "/api/projects")
      .then(setProjects)
      .catch((e: Error) => setError(e.message));
  }, [server]);

  const choose = (project: ServerProject) => {
    setBusy(true);
    setError("");
    void (async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const parent = await open({ directory: true, title: t("collab.open.choose") });
      if (typeof parent !== "string") return;
      const folder = await invoke<string>("sync_create_folder", { parent, name: project.name });
      const link = { server, project: project.id, name: project.name };
      await setLink(folder, link);
      rememberFolder(folder, link);
      onOpened(folder);
    })()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/30 p-5">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("collab.open.title")}
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 overflow-y-auto border-2 border-foreground bg-background p-5 text-sm shadow-[4px_4px_0_0_var(--foreground)]"
      >
        <h2 className="text-base font-bold">{t("collab.open.title")}</h2>
        {accounts && !accounts.length ? (
          <ServerAccounts onChanged={loadAccounts} />
        ) : (
          <>
            {accounts && accounts.length > 1 && (
              <label className="block text-xs">
                {t("collab.panel.server")}
                <select
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  className="mt-1 w-full border border-border bg-background p-2 text-sm"
                >
                  {accounts.map((a) => (
                    <option key={a.server} value={a.server}>
                      {a.server} · {a.user.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="text-xs text-muted-foreground">{t("collab.open.hint")}</p>
            {projects === null ? (
              <p className="text-muted-foreground">{t("collab.open.loading")}</p>
            ) : projects.length ? (
              <ul className="space-y-2">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => choose(project)}
                      className={`flex w-full items-center justify-between border p-3 text-left hover:border-foreground disabled:opacity-50 ${
                        project.id === initial?.project ? "border-foreground" : "border-border"
                      }`}
                    >
                      <span className="truncate font-medium">{project.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t(roleKey(project.role))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">{t("collab.open.empty")}</p>
            )}
          </>
        )}
        {busy && <p className="text-xs text-muted-foreground">{t("collab.open.working")}</p>}
        {error && (
          <p role="alert" className="text-xs text-red-600 break-words">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="border border-border px-4 py-1.5 hover:border-foreground"
          >
            {t("common.close")}
          </button>
        </div>
      </section>
    </div>
  );
}
