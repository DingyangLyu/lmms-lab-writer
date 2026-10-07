/**
 * Server-side LaTeX builds for the browser PDF preview. Each build runs latexmk in a fresh
 * temporary directory with shell escape off and TeX file access restricted to that directory.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { sql } from "./db";
import type { Store } from "./store";
import { OUTPUT_DIR, parseSyncTex, type SyncTex } from "./synctex";
import { decodeText, fail, safePath, uid } from "./util";

export const engines = ["pdflatex", "xelatex", "lualatex"] as const;
export type Engine = (typeof engines)[number];
export type Issue = {
  level: "error" | "warning";
  file: string | null;
  line: number | null;
  message: string;
};
export type BuildSummary = {
  id: string;
  main: string;
  engine: Engine;
  status: "success" | "failed";
  issues: Issue[];
  log: string;
  pdf: boolean;
  duration: number;
  created: number;
  author: string;
};
export type CompileOptions = {
  /** latexmk executable; default `latexmk` from PATH. */
  latexmk?: string;
  timeoutMs?: number;
  /** Builds running at once across all projects. */
  concurrency?: number;
};
const KEEP = 2,
  MAX_PDF = 50_000_000,
  MAX_SYNCTEX = 20_000_000,
  MAX_LOG = 200_000;
const flags: Record<Engine, string> = {
  pdflatex: "-pdf",
  xelatex: "-xelatex",
  lualatex: "-lualatex",
};

/** file-line-error messages and LaTeX warnings from a TeX log. */
export function parseLog(log: string, buildDir: string): Issue[] {
  const issues: Issue[] = [];
  // Files outside the build directory (TeX's own classes and packages) are not editable.
  const relative = (file: string) => {
    if (file.startsWith(`${buildDir}/`)) return file.slice(buildDir.length + 1);
    if (file.startsWith("/")) return null;
    return file.replace(/^(\.\/)+/, "");
  };
  const lines = log.split("\n");
  for (let i = 0; i < lines.length && issues.length < 100; i++) {
    const line = lines[i] ?? "";
    const error = /^(\.?\.?\/?[^:\n]*\.(?:tex|sty|cls|bib|bbl)):(\d+): (.+)$/.exec(line);
    if (error?.[1] && error[2] && error[3]) {
      // TeX wraps long messages; the next line continues it unless it is a context line.
      const next = lines[i + 1] ?? "";
      const message = /^(l\.\d+|$)/.test(next) ? error[3] : `${error[3]} ${next.trim()}`;
      issues.push({ level: "error", file: relative(error[1]), line: Number(error[2]), message });
      continue;
    }
    const warning = /^(?:LaTeX|Package \S+) Warning: (.+)$/.exec(line);
    if (warning?.[1]) {
      let message = warning[1];
      for (let j = i + 1; j < lines.length && /^\(\S+\)\s/.test(lines[j] ?? ""); j++)
        message += ` ${(lines[j] ?? "").replace(/^\(\S+\)\s+/, "")}`;
      const at = /on input line (\d+)\.?/.exec(message);
      issues.push({
        level: "warning",
        file: null,
        line: at?.[1] ? Number(at[1]) : null,
        message: message.replace(/\s+/g, " ").trim(),
      });
    }
  }
  return issues;
}

export class Compiler {
  private running = new Set<string>();
  private active = 0;
  private waiting: Array<() => void> = [];
  private parsed = new Map<string, SyncTex>();
  constructor(
    private store: Store,
    private options: CompileOptions = {},
  ) {}
  private async slot() {
    if (this.active < (this.options.concurrency ?? 2)) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
  async compile(project: string, author: string, main: string, engine: Engine) {
    safePath(main);
    if (!main.endsWith(".tex")) fail(400, "请选择 .tex 主文件");
    if (!engines.includes(engine)) fail(400, "不支持的编译器");
    if (this.running.has(project)) fail(409, "这个项目正在编译，请稍候");
    this.running.add(project);
    try {
      const files = await this.store.projectFiles(project);
      if (!files.some((f) => f.path === main && !f.binary)) fail(404, `项目中没有 ${main}`);
      await this.slot();
      try {
        return await this.build(project, author, main, engine, files);
      } finally {
        this.release();
      }
    } finally {
      this.running.delete(project);
    }
  }
  private async build(
    project: string,
    author: string,
    main: string,
    engine: Engine,
    files: Awaited<ReturnType<Store["projectFiles"]>>,
  ): Promise<BuildSummary> {
    const started = Date.now();
    // TeX records real paths (macOS /var is /private/var); SyncTeX mapping needs the same.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "writer-build-")));
    try {
      for (const f of files) {
        const target = join(dir, safePath(f.path));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, f.binary ? f.state : decodeText(f.state));
      }
      const output = await this.run(dir, main, engine);
      const stem = join(dir, OUTPUT_DIR, basename(main, ".tex"));
      const read = async (path: string, max: number) => {
        const info = await stat(path).catch(() => null);
        return info && info.size <= max ? readFile(path) : null;
      };
      const texLog = (await readFile(`${stem}.log`, "utf8").catch(() => "")) || output.text;
      const pdf = await read(`${stem}.pdf`, MAX_PDF);
      const synctex = pdf ? await read(`${stem}.synctex.gz`, MAX_SYNCTEX) : null;
      const issues = parseLog(texLog, dir);
      if (output.timedOut)
        issues.unshift({ level: "error", file: null, line: null, message: "编译超时，已停止" });
      else if (output.code !== 0 && !issues.some((i) => i.level === "error"))
        issues.unshift({
          level: "error",
          file: null,
          line: null,
          message: `编译失败（latexmk 退出码 ${output.code}），请查看日志`,
        });
      const summary: BuildSummary = {
        id: uid(),
        main,
        engine,
        status: output.code === 0 && !output.timedOut && pdf ? "success" : "failed",
        issues,
        log: `${texLog.slice(-MAX_LOG)}\n\n--- latexmk ---\n${output.text.slice(-20_000)}`,
        pdf: !!pdf,
        duration: Date.now() - started,
        created: Date.now(),
        author,
      };
      await this.store.db.transaction(async (tx) => {
        await tx.run(
          sql`INSERT INTO builds(id, project, author, main, engine, status, issues, log, pdf, synctex, build_dir, duration, created)
              VALUES(${summary.id}, ${project}, ${author}, ${main}, ${engine}, ${summary.status},
                     ${JSON.stringify(issues)}, ${summary.log}, ${pdf}, ${synctex}, ${dir},
                     ${summary.duration}, ${summary.created})`,
        );
        await tx.run(
          sql`DELETE FROM builds WHERE project=${project} AND id NOT IN
                (SELECT id FROM builds WHERE project=${project} ORDER BY created DESC, id DESC LIMIT ${KEEP})`,
        );
      });
      return summary;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  private run(dir: string, main: string, engine: Engine) {
    const latexmk = this.options.latexmk || "latexmk";
    return new Promise<{ code: number | null; text: string; timedOut: boolean }>(
      (resolve, reject) => {
        const child = spawn(
          latexmk,
          [
            "-norc",
            "-interaction=nonstopmode",
            "-file-line-error",
            "-no-shell-escape",
            "-synctex=1",
            "-f",
            flags[engine],
            `-outdir=${OUTPUT_DIR}`,
            main,
          ],
          {
            cwd: dir,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              PATH: process.env.PATH ?? "",
              HOME: dir,
              TMPDIR: dir,
              LANG: process.env.LANG ?? "C.UTF-8",
              // TeX may only read and write inside the build directory (plus its own trees).
              openin_any: "p",
              openout_any: "p",
              shell_escape: "f",
              // A shared cache keeps LuaLaTeX from rebuilding its font database per build.
              TEXMFVAR: process.env.WRITER_TEXMFVAR || join(dir, "texmf-var"),
              ...(process.env.TEXMFHOME ? { TEXMFHOME: process.env.TEXMFHOME } : {}),
            },
          },
        );
        let text = "",
          timedOut = false;
        const append = (chunk: Buffer) => {
          text = (text + chunk.toString()).slice(-40_000);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const kill = (signal: NodeJS.Signals) => {
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch {}
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), 3000).unref();
        }, this.options.timeoutMs ?? 120_000);
        child.once("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(
            error.code === "ENOENT"
              ? Object.assign(new Error("missing latexmk"), { status: 503 })
              : error,
          );
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code, text, timedOut });
        });
      },
    ).catch((error: Error & { status?: number }) =>
      error.status === 503
        ? fail(503, "服务器没有安装 TeX（latexmk），请管理员安装 TeX Live 或使用含 TeX 的镜像")
        : Promise.reject(error),
    );
  }
  async latest(project: string) {
    const row = await this.store.db.row<BuildSummary & { issues: string; pdf: boolean }>(
      sql`SELECT id, main, engine, status, issues, log, pdf IS NOT NULL AS pdf, duration, created, author
          FROM builds WHERE project=${project} ORDER BY created DESC, id DESC LIMIT 1`,
    );
    return row ? { ...row, issues: JSON.parse(row.issues) as Issue[] } : null;
  }
  async pdf(project: string, id: string) {
    return (
      (
        await this.store.db.row<{ pdf: Uint8Array | null }>(
          sql`SELECT pdf FROM builds WHERE project=${project} AND id=${id}`,
        )
      )?.pdf ?? fail(404, "没有这个编译结果的 PDF")
    );
  }
  async synctex(project: string, id: string) {
    const cached = this.parsed.get(id);
    if (cached) return cached;
    const row =
      (await this.store.db.row<{ synctex: Uint8Array | null; build_dir: string }>(
        sql`SELECT synctex, build_dir FROM builds WHERE project=${project} AND id=${id}`,
      )) ?? fail(404, "编译结果已过期，请重新编译");
    if (!row.synctex) fail(404, "这次编译没有 SyncTeX 数据");
    const parsed = parseSyncTex(row.synctex, row.build_dir);
    this.parsed.set(id, parsed);
    for (const key of [...this.parsed.keys()].slice(0, -8)) this.parsed.delete(key);
    return parsed;
  }
}
