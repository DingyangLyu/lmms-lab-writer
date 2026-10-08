import { useEffect, useState } from "react";
import type { Role, SharedJob, SharedRunnerInfo } from "../shared/api";
import { api, errorText } from "./api";
import { copyText } from "./clipboard";
import { type MessageKey, useI18n } from "./i18n";

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
  role,
  jobs,
  currentFile,
  reload,
  onError,
}: {
  project: string;
  role: Role;
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
  const canEdit = ["owner", "editor"].includes(role),
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
    <>
      <h2>{t("tasks.title")}</h2>
      <p className="muted">{t("tasks.lead")}</p>
      {shared && (
        <p className="muted">
          {t("tasks.sharedRunner", {
            name: shared.name,
            harnesses: shared.capabilities
              .map((c) => HARNESS_NAMES[c] ?? c)
              .join(t("tasks.listSeparator")),
          })}
        </p>
      )}
      <select
        aria-label={t("tasks.harness")}
        value={harness}
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
      <textarea
        aria-label={t("tasks.prompt")}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={
          harness.startsWith("compile:")
            ? t("tasks.compilePlaceholder")
            : t("tasks.promptPlaceholder")
        }
      />
      <button
        type="button"
        disabled={!canEdit || busy || !prompt.trim()}
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
      {role === "owner" && (
        <details className="runner">
          <summary>{t("tasks.runner")}</summary>
          <p className="muted">{t("tasks.runnerLead")}</p>
          <p className="muted">{t("tasks.runnerDesktop")}</p>
          <button
            type="button"
            disabled={busy}
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
            <>
              <label>
                {t("tasks.token")}
                <input aria-label={t("tasks.tokenLabel")} type="password" readOnly value={token} />
              </label>
              <button type="button" onClick={() => void copyText(token)}>
                {t("tasks.copyToken")}
              </button>
              <p className="muted">{t("tasks.tokenHint")}</p>
            </>
          )}
        </details>
      )}
      {jobs.map((j) => (
        <article className="snapshot" key={j.id}>
          <strong>
            {j.harness} · {STATUS[j.status] ? t(STATUS[j.status] as MessageKey) : j.status}
          </strong>
          <p>{j.prompt}</p>
          <p className="muted">
            {new Date(j.created).toLocaleString(locale === "zh" ? "zh-CN" : "en")}
          </p>
          {j.result && (
            <details>
              <summary>{t("tasks.result")}</summary>
              <pre>{j.result}</pre>
            </details>
          )}
          {canEdit && ["queued", "running"].includes(j.status) && (
            <button
              type="button"
              disabled={busy}
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
    </>
  );
}
