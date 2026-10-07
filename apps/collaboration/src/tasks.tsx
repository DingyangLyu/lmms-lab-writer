import { useState } from "react";
import type { Role, SharedJob } from "../shared/api";
import { api } from "./api";
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
  const [harness, setHarness] = useState("codex"),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false),
    [token, setToken] = useState("");
  const canEdit = ["owner", "editor"].includes(role),
    prefix = `/projects/${project}`;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2>共享任务</h2>
      <p className="muted">
        任务使用提交时的项目快照，AI 输出进入“审阅”；编译 PDF
        作为新产物保存。执行器断线会报告失败，不会覆盖正文。
      </p>
      <select
        aria-label="任务执行环境"
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
        <option value="compile:xelatex">编译 · XeLaTeX</option>
        <option value="compile:pdflatex">编译 · pdfLaTeX</option>
        <option value="compile:lualatex">编译 · LuaLaTeX</option>
      </select>
      <textarea
        aria-label="共享任务要求"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={
          harness.startsWith("compile:") ? "主文件相对路径，例如 main.tex" : "描述需要修改的内容…"
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
        加入共享任务队列
      </button>
      {role === "owner" && (
        <details className="runner">
          <summary>连接本机执行器</summary>
          <p className="muted">
            为此项目创建能力受限的令牌。编译使用隔离 Docker 容器；AI 由你自己的本机 CLI
            执行，仅为可信合作者启用。登录凭据不上传到服务端。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api<{ token: string }>(`${prefix}/runners`, {
                  name: "本机执行器",
                  capabilities: [harness.startsWith("compile:") ? "compile" : harness],
                });
                setToken(result.token);
              })
            }
          >
            创建当前能力的执行器令牌
          </button>
          {token && (
            <>
              <label>
                令牌（仅显示本次）
                <input aria-label="执行器令牌" type="password" readOnly value={token} />
              </label>
              <button type="button" onClick={() => void navigator.clipboard.writeText(token)}>
                复制令牌
              </button>
              <p className="muted">
                按部署说明设置 WRITER_RUNNER_TOKEN，然后启动 runner。不要把此令牌发给其他人。
              </p>
            </>
          )}
        </details>
      )}
      {jobs.map((j) => (
        <article className="snapshot" key={j.id}>
          <strong>
            {j.harness} ·{" "}
            {{
              queued: "排队中",
              running: "执行中",
              completed: "已完成",
              failed: "失败",
              cancelled: "已取消",
            }[j.status] || j.status}
          </strong>
          <p>{j.prompt}</p>
          <p className="muted">{new Date(j.created).toLocaleString()}</p>
          {j.result && (
            <details>
              <summary>结果 / 日志</summary>
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
              取消任务
            </button>
          )}
        </article>
      ))}
    </>
  );
}
