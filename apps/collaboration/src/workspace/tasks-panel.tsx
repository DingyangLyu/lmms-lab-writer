import { RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Role, SharedJob, SharedRunnerInfo } from "../../shared/api";
import { api, errorText } from "../api";
import { copyText } from "../clipboard";
import { type MessageKey, useI18n } from "../i18n";

const STATUS: Record<string, MessageKey> = {
  queued: "tasks.status.queued",
  running: "tasks.status.running",
  completed: "tasks.status.completed",
  failed: "tasks.status.failed",
  cancelled: "tasks.status.cancelled",
};
const HARNESS_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  compile: "LaTeX",
};
export function TasksPanel({
  project,
  memberRole,
  jobs,
  currentFile,
  reload,
  onError,
}: {
  project: string;
  memberRole: Role;
  jobs: SharedJob[];
  currentFile?: string;
  reload: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const [harness, setHarness] = useState("codex"),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false),
    [token, setToken] = useState(""),
    [shared, setShared] = useState<SharedRunnerInfo | null>(null);
  useEffect(() => {
    let current = true;
    api<{ runner: SharedRunnerInfo | null }>(`/projects/${project}/shared-runner`)
      .then((result) => {
        if (current) setShared(result.runner);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [project]);
  const canEdit = ["owner", "editor"].includes(memberRole),
    prefix = `/projects/${project}`;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <RobotIcon className="size-4" />
        <strong className="font-medium">{t("tasks.title")}</strong>
      </div>
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <p className="text-muted">{t("tasks.lead")}</p>
        {shared && (
          <p className="text-muted">
            {t("tasks.sharedRunner", {
              name: shared.name,
              harnesses: shared.capabilities
                .map((c) => HARNESS_NAMES[c] ?? c)
                .join(t("tasks.listSeparator")),
            })}
          </p>
        )}
        <div className="writer-composer-card border border-border focus-within:border-foreground">
          <textarea
            aria-label={t("tasks.prompt")}
            value={prompt}
            rows={4}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              harness.startsWith("compile:")
                ? t("tasks.compilePlaceholder")
                : t("tasks.promptPlaceholder")
            }
            className="block w-full resize-y bg-transparent p-3 leading-relaxed outline-none"
          />
          <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
            <select
              aria-label={t("tasks.harness")}
              value={harness}
              className="h-7 border border-border bg-background px-1"
              onChange={(e) => {
                setHarness(e.target.value);
                if (e.target.value.startsWith("compile:"))
                  setPrompt(currentFile?.endsWith(".tex") ? currentFile : "main.tex");
              }}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
              <option value="opencode">OpenCode</option>
              <option value="compile:xelatex">{t("tasks.compile", { engine: "XeLaTeX" })}</option>
              <option value="compile:pdflatex">{t("tasks.compile", { engine: "pdfLaTeX" })}</option>
              <option value="compile:lualatex">{t("tasks.compile", { engine: "LuaLaTeX" })}</option>
            </select>
            <span className="flex-1" />
            <button
              type="button"
              disabled={!canEdit || busy || !prompt.trim()}
              className="border border-foreground bg-foreground px-3 py-1 text-background disabled:opacity-40"
              onClick={() =>
                void run(async () => {
                  await api(`${prefix}/jobs`, { harness, prompt });
                  setPrompt("");
                  await reload();
                })
              }
            >
              {t("tasks.submit")}
            </button>
          </div>
        </div>
        {memberRole === "owner" && (
          <details>
            <summary className="cursor-pointer text-muted">{t("tasks.runner")}</summary>
            <div className="mt-2 space-y-2">
              <p className="text-muted">{t("tasks.runnerLead")}</p>
              <p className="text-muted">{t("tasks.runnerDesktop")}</p>
              <button
                type="button"
                disabled={busy}
                className="border border-border px-2 py-1 hover:border-foreground disabled:opacity-40"
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ token: string }>(`${prefix}/runners`, {
                      name: t("tasks.runnerName"),
                      capabilities: [harness.startsWith("compile:") ? "compile" : harness],
                    });
                    setToken(result.token);
                  })
                }
              >
                {t("tasks.createToken")}
              </button>
              {token && (
                <div className="space-y-2">
                  <label className="block">
                    {t("tasks.token")}
                    <input
                      aria-label={t("tasks.tokenLabel")}
                      type="password"
                      readOnly
                      value={token}
                      className="mt-1 block w-full border border-border bg-background px-2 py-1"
                    />
                  </label>
                  <button
                    type="button"
                    className="border border-border px-2 py-1 hover:border-foreground"
                    onClick={() => void copyText(token)}
                  >
                    {t("tasks.copyToken")}
                  </button>
                  <p className="text-muted">{t("tasks.tokenHint")}</p>
                </div>
              )}
            </div>
          </details>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {jobs.map((j) => (
          <article key={j.id} className="space-y-1 border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <strong className="font-medium">
                {HARNESS_NAMES[j.harness.split(":")[0] ?? ""] ?? j.harness}
              </strong>
              <span className={j.status === "failed" ? "text-red-600" : "text-muted"}>
                {STATUS[j.status] ? t(STATUS[j.status] as MessageKey) : j.status}
              </span>
              <span className="ml-auto text-muted">
                {new Date(j.created).toLocaleString(locale === "zh" ? "zh-CN" : "en")}
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words">{j.prompt}</p>
            {j.result && (
              <details>
                <summary className="cursor-pointer text-muted">{t("tasks.result")}</summary>
                <pre className="mt-1 whitespace-pre-wrap break-all text-[11px]">{j.result}</pre>
              </details>
            )}
            {canEdit && ["queued", "running"].includes(j.status) && (
              <button
                type="button"
                disabled={busy}
                className="border border-border px-2 py-1 hover:border-foreground disabled:opacity-40"
                onClick={() =>
                  void run(async () => {
                    await api(`${prefix}/jobs/${j.id}`, {}, "DELETE");
                    await reload();
                  })
                }
              >
                {t("tasks.cancel")}
              </button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
