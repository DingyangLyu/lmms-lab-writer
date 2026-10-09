/** Opt-in local worker. Server never receives native CLI credentials or shell access. */
import "./environment";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startAgentHost } from "./agent-host";
import { isTextPath, safePath } from "./util";

type Job = {
  id: string;
  prompt: string;
  harness: string;
  files: { id: string; path: string; binary: boolean; content?: string; base64?: string }[];
};
type Output = { path: string; content?: string; base64?: string };
const origin = (process.env.WRITER_SERVER || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.WRITER_RUNNER_TOKEN || "";
const allowed = (process.env.WRITER_ALLOWED_HARNESSES || "compile").split(",");
async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${origin}/api/runner/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Origin: origin,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Worker request failed");
  return result as T;
}
export async function executeJob(job: Job, work: string, heartbeat: () => Promise<unknown>) {
  const kind = job.harness.startsWith("compile:") ? "compile" : job.harness;
  if (!allowed.includes(kind)) throw new Error(`本机未启用 ${kind} 执行器`);
  // Project-level agent config is never handed to the local CLI, and never reported deleted.
  const withheld = new Set<string>();
  for (const file of job.files) {
    if (["opencode.json", "opencode.jsonc"].includes(basename(file.path).toLowerCase())) {
      withheld.add(file.path);
      continue;
    }
    const path = join(work, safePath(file.path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      file.binary ? Buffer.from(file.base64 || "", "base64") : file.content || "",
    );
  }
  let command: string,
    args: string[],
    input = "";
  if (kind === "compile") {
    if (!/^[\p{L}\p{N}_./ -]+\.tex$/u.test(job.prompt)) throw new Error("编译入口包含不支持的字符");
    safePath(job.prompt);
    const engine = job.harness.split(":")[1];
    if (!["pdflatex", "xelatex", "lualatex"].includes(engine || ""))
      throw new Error("不支持的编译器");
    const flags =
      engine === "xelatex" ? ["-xelatex"] : engine === "lualatex" ? ["-lualatex"] : ["-pdf"];
    command = "docker";
    args = [
      "run",
      "--rm",
      "--name",
      `writer-job-${job.id}`,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--cpus=1",
      "--memory=1g",
      "--pids-limit=128",
      "--user",
      `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
      "--tmpfs",
      "/tmp:rw,nosuid,size=256m",
      "--mount",
      `type=bind,src=${work},dst=/work`,
      "--workdir",
      "/work",
      process.env.WRITER_TEX_IMAGE || "writer-tex:local",
      "latexmk",
      "-norc",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
      "-no-shell-escape",
      ...flags,
      "-outdir=build-output",
      `./${job.prompt}`,
    ];
  } else {
    input = `You are editing a disposable snapshot for Writer collaboration. Follow this user task: ${job.prompt}\nEdit project text files only. Do not read credentials or unrelated directories. Your changes will be returned as proposals; reviewers choose whether to apply them. Do not publish or push anything.\n`;
    if (kind === "codex") {
      command = process.env.WRITER_CODEX_BIN || "codex";
      // danger-full-access where Codex's own sandbox cannot run (e.g. a Windows service account).
      args = [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        process.env.WRITER_CODEX_SANDBOX || "workspace-write",
        "-c",
        'approval_policy="never"',
        "-",
      ];
    } else if (kind === "claude") {
      command = process.env.WRITER_CLAUDE_BIN || "claude";
      args = [
        "-p",
        "--permission-mode",
        "acceptEdits",
        "--tools",
        "Read,Write,Edit,Glob,Grep",
        "--output-format",
        "text",
      ];
    } else if (kind === "opencode") {
      command = process.env.WRITER_OPENCODE_BIN || "opencode";
      args = ["run"];
    } else throw new Error("未知执行器");
    const model = process.env[`WRITER_${kind.toUpperCase()}_MODEL`];
    if (model) {
      if (kind === "codex") args.splice(args.length - 1, 0, "--model", model);
      else args.push("--model", model);
    }
  }
  // The agent runs collaborators' prompts: it gets none of Writer's tokens, passwords or database.
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv))
    if (/^WRITER_.*(TOKEN|PASSWORD|DATABASE_URL)/.test(key)) delete childEnv[key];
  const child = spawn(command, args, {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: {
      ...childEnv,
      ...(kind === "opencode"
        ? {
            OPENCODE_PERMISSION: JSON.stringify({
              external_directory: "deny",
              bash: "deny",
              edit: "allow",
              read: "allow",
              webfetch: "allow",
            }),
          }
        : {}),
    },
  });
  let log = "",
    stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill();
    } catch {}
    if (kind === "compile") {
      const cleanup = spawn("docker", ["rm", "-f", `writer-job-${job.id}`], { stdio: "ignore" });
      cleanup.on("error", () => {});
    }
    const kill = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, 3000);
    kill.unref();
  };
  const append = (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-45000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.stdin.end(input);
  const timer = setTimeout(stop, kind === "compile" ? 120000 : 600000);
  let pinging = false;
  const ping = setInterval(() => {
    if (pinging) return;
    pinging = true;
    void heartbeat()
      .catch(stop)
      .finally(() => {
        pinging = false;
      });
  }, 15000);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
  } finally {
    clearTimeout(timer);
    clearInterval(ping);
  }
  if (code !== 0 || stopped) throw new Error(`任务停止或失败（${code}）：${log}`);
  const outputs: Output[] = [];
  if (kind === "compile") {
    const pdf = join(work, "build-output", `${basename(job.prompt, ".tex")}.pdf`);
    const bytes = await readFile(pdf);
    if (bytes.length > 8_000_000 || bytes.subarray(0, 5).toString() !== "%PDF-")
      throw new Error("PDF 无效或超过 8 MB");
    outputs.push({ path: basename(pdf), base64: bytes.toString("base64") });
  } else {
    const visit = async (dir: string, relative = "") => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (
          item.name.startsWith(".") ||
          ["node_modules", "build", "dist", "target"].includes(item.name)
        )
          continue;
        const path = relative ? `${relative}/${item.name}` : item.name;
        if (item.isSymbolicLink() || withheld.has(path)) continue;
        if (item.isDirectory()) {
          await visit(join(dir, item.name), path);
          continue;
        }
        if (!item.isFile()) continue;
        const old = job.files.find((f) => f.path === path);
        const bytes = await readFile(join(work, path));
        if (bytes.length > 2_000_000) continue;
        if (isTextPath(path)) {
          const content = bytes.toString("utf8");
          if (content !== old?.content) outputs.push({ path, content });
        } else if (/\.(png|jpe?g|svg|pdf)$/i.test(path) && bytes.toString("base64") !== old?.base64)
          outputs.push({ path, base64: bytes.toString("base64") });
        if (outputs.length > 200) throw new Error("任务产物过多");
      }
    };
    await visit(work);
    for (const old of job.files.filter((f) => !f.binary && !withheld.has(f.path)))
      try {
        await readFile(join(work, old.path));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          outputs.push({ path: old.path, content: "" });
        else throw e;
      }
  }
  return { files: outputs, result: log || "任务完成，输出已提交审阅。" };
}
export async function runWorker() {
  if (!token) throw new Error("请设置项目专属 WRITER_RUNNER_TOKEN");
  console.log(`Writer runner connected to ${origin}; capabilities: ${allowed.join(",")}`);
  // Live AI conversations from the web (shared runner only; the server refuses other tokens).
  if (allowed.includes("codex") && process.env.WRITER_AGENT_HOST !== "0")
    startAgentHost({ server: origin, token });
  while (true) {
    let work = "",
      job: Job | null = null;
    try {
      ({ job } = await request<{ job: Job | null }>("lease", {}));
      if (!job) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      work = await mkdtemp(join(tmpdir(), "writer-job-"));
      const id = job.id,
        result = await executeJob(job, work, () => request("heartbeat", { id }));
      await request("result", { id, ...result });
      await rm(work, { recursive: true, force: true });
      work = "";
    } catch (error) {
      console.error("Worker task failed:", String(error));
      if (work) console.error(`Recovery workspace retained: ${work}`);
      if (job)
        await request("result", {
          id: job.id,
          error: true,
          result: String(error).slice(-45000),
          files: [],
        }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  void runWorker().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
