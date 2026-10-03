import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { reviewHunks } from "@lmms-lab/writing";
import * as Y from "yjs";
import type { Collaboration } from "./collaboration";
import {
  decodeText,
  digest,
  fail,
  type Role,
  type Store,
  safePath,
  textDoc,
  type User,
  uid,
} from "./store";

type Body = Record<string, unknown>;
type Job = {
  id: string;
  project: string;
  author: string;
  prompt: string;
  harness: string;
  status: string;
  runner: string | null;
  lease: number | null;
  result: string;
  created: number;
  base: string;
};
type Runner = { id: string; project: string; token: string; name: string; capabilities: string };
type Snapshot = {
  files: { id: string; path: string; state: string; binary: number; deleted: number }[];
};
const text = (body: Body, key: string, max = 10000) =>
  typeof body[key] === "string" && body[key].length <= max
    ? (body[key] as string)
    : fail(400, `无效字段 ${key}`);
export function runnerRequest(
  store: Store,
  collab: Collaboration,
  req: IncomingMessage,
  path: string,
  body: Body,
) {
  const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
  const runner =
    store.get<Runner>("SELECT * FROM runners WHERE token=?", digest(token)) ??
    fail(401, "Runner 凭据无效");
  if (path === "/api/runner/lease") {
    const caps = JSON.parse(runner.capabilities) as string[];
    store.run(
      "UPDATE jobs SET status='failed',result='执行器失联，可重新提交任务' WHERE project=? AND status='running' AND lease<?",
      runner.project,
      Date.now(),
    );
    return store.transaction(() => {
      const jobs = store.all<Job>(
        "SELECT * FROM jobs WHERE project=? AND status='queued' ORDER BY created LIMIT 50",
        runner.project,
      );
      const job = jobs.find((j) =>
        caps.includes(j.harness.startsWith("compile:") ? "compile" : j.harness),
      );
      if (!job) return { job: null };
      store.require(job.project, job.author, "edit");
      store.run(
        "UPDATE jobs SET status='running',runner=?,lease=? WHERE id=? AND status='queued'",
        runner.id,
        Date.now() + 60000,
        job.id,
      );
      const snapshot =
        store.get<{ data: string }>(
          "SELECT data FROM snapshots WHERE id=? AND project=?",
          job.base,
          job.project,
        ) ?? fail(404, "任务快照不存在");
      const files = (JSON.parse(snapshot.data) as Snapshot).files
        .filter((f) => !f.deleted)
        .map((f) => ({
          id: f.id,
          path: f.path,
          binary: !!f.binary,
          ...(f.binary
            ? { base64: f.state }
            : { content: decodeText(Buffer.from(f.state, "base64")) }),
        }));
      collab.changed(runner.project);
      return { job: { ...job, files } };
    });
  }
  const id = text(body, "id", 80),
    job =
      store.get<Job>(
        "SELECT * FROM jobs WHERE id=? AND project=? AND runner=?",
        id,
        runner.project,
        runner.id,
      ) ?? fail(404, "任务不存在");
  if (job.status !== "running") fail(409, "任务已结束或取消");
  store.require(job.project, job.author, "edit");
  if (path === "/api/runner/heartbeat") {
    store.run("UPDATE jobs SET lease=? WHERE id=?", Date.now() + 60000, id);
    return { ok: true };
  }
  if (path !== "/api/runner/result") fail(404, "接口不存在");
  const result = text(body, "result", 50000),
    error = body.error === true;
  if (error) {
    store.run("UPDATE jobs SET status='failed',result=? WHERE id=?", result, id);
    collab.changed(job.project);
    return { ok: true };
  }
  const raw = body.files;
  if (!Array.isArray(raw) || raw.length > 200) fail(400, "任务输出文件无效");
  const snapshot =
    store.get<{ data: string }>("SELECT data FROM snapshots WHERE id=?", job.base) ??
    fail(404, "任务快照不存在");
  const baseline = (JSON.parse(snapshot.data) as Snapshot).files;
  const files = raw.map((value) => {
    if (!value || typeof value !== "object") fail(400, "无效输出");
    const file = value as Body,
      path = safePath(text(file, "path", 240));
    if (typeof file.content === "string" && file.content.length <= 2_000_000)
      return { path, content: file.content, binary: null };
    if (
      typeof file.base64 === "string" &&
      file.base64.length <= 12_000_000 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)
    )
      return { path, content: null, binary: Buffer.from(file.base64, "base64") };
    return fail(400, "输出超过限制");
  });
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) fail(400, "输出路径重复");
    seen.add(f.path);
  }
  const ids: string[] = [];
  store.transaction(() => {
    for (const f of files) {
      if (f.binary) {
        // Generated assets are new artifacts, never an overwrite of a collaborator's file.
        const path = `artifacts/${job.id}/${f.path}`;
        if (path.length > 240) fail(400, "产物路径过长");
        const id = uid();
        store.run(
          "INSERT INTO files(id,project,path,state,binary) VALUES(?,?,?,?,1)",
          id,
          job.project,
          path,
          f.binary,
        );
        continue;
      }
      const old = baseline.find((old) => old.path === f.path && !old.deleted);
      if (old?.binary) fail(400, "不能用文本覆盖二进制文件");
      const base = old ? decodeText(Buffer.from(old.state, "base64")) : "";
      if (base === f.content) continue;
      let file = store.get<{ id: string }>(
        "SELECT id FROM files WHERE project=? AND path=? AND deleted=0",
        job.project,
        f.path,
      );
      if (!file) {
        const id = uid(),
          doc = textDoc("");
        store.run(
          "INSERT INTO files(id,project,path,state,binary) VALUES(?,?,?,?,0)",
          id,
          job.project,
          f.path,
          Y.encodeStateAsUpdate(doc),
        );
        doc.destroy();
        file = { id };
      }
      const id = uid(),
        hunks = reviewHunks(base, f.content || "");
      store.run(
        "INSERT INTO proposals VALUES(?,?,?,?,?,?,?,1,?)",
        id,
        job.project,
        file.id,
        job.author,
        base,
        f.content || "",
        JSON.stringify(hunks),
        Date.now(),
      );
      ids.push(id);
    }
    store.run("UPDATE jobs SET status='completed',result=? WHERE id=?", result, id);
    store.audit(job.project, job.author, "task.completed", {
      id,
      runner: runner.name,
      proposals: ids,
    });
  });
  collab.changed(job.project);
  return { ok: true, proposals: ids };
}
export function projectJobs(
  store: Store,
  collab: Collaboration,
  project: string,
  user: User,
  _role: Role,
  rest: string,
  method: string,
  body: Body,
): unknown {
  if (rest === "runners" && method === "POST") {
    store.require(project, user.id, "owner");
    const name = text(body, "name", 100),
      capabilities = body.capabilities;
    if (
      !Array.isArray(capabilities) ||
      !capabilities.length ||
      capabilities.some((c) => !["compile", "codex", "claude", "opencode"].includes(c))
    )
      fail(400, "请选择执行器能力");
    const token = randomBytes(32).toString("hex"),
      id = uid();
    store.run(
      "INSERT INTO runners VALUES(?,?,?,?,?)",
      id,
      project,
      digest(token),
      name,
      JSON.stringify(capabilities),
    );
    return { id, token };
  }
  if (rest === "runners" && method === "GET") {
    store.require(project, user.id, "owner");
    return store.all("SELECT id,name,capabilities FROM runners WHERE project=?", project);
  }
  if (rest.startsWith("runners/") && method === "DELETE") {
    store.require(project, user.id, "owner");
    store.run("DELETE FROM runners WHERE project=? AND id=?", project, rest.slice(8));
    return { ok: true };
  }
  if (rest === "jobs" && method === "GET")
    return store.all(
      "SELECT id,author,prompt,harness,status,result,created FROM jobs WHERE project=? ORDER BY created DESC LIMIT 100",
      project,
    );
  if (rest === "jobs" && method === "POST") {
    store.require(project, user.id, "edit");
    const prompt = text(body, "prompt", 20000),
      harness = text(body, "harness", 80);
    if (
      ![
        "codex",
        "claude",
        "opencode",
        "compile:pdflatex",
        "compile:xelatex",
        "compile:lualatex",
      ].includes(harness)
    )
      fail(400, "不支持的执行环境");
    if (harness.startsWith("compile:")) {
      safePath(prompt);
      if (!prompt.endsWith(".tex")) fail(400, "请选择 .tex 入口");
    }
    const count =
      store.get<{ n: number }>(
        "SELECT count(*) AS n FROM jobs WHERE project=? AND status IN ('queued','running')",
        project,
      )?.n ?? 0;
    if (count >= 10) fail(429, "本项目最多 10 个排队/执行中的任务");
    const id = uid();
    store.transaction(() => {
      const snapshot = store.snapshot(project, user.id, "共享任务输入版本");
      store.run(
        "INSERT INTO jobs(id,project,author,prompt,harness,status,created,base) VALUES(?,?,?,?,?,'queued',?,?)",
        id,
        project,
        user.id,
        prompt,
        harness,
        Date.now(),
        snapshot,
      );
      store.audit(project, user.id, "task.queued", { id, harness });
    });
    collab.changed(project);
    return { id };
  }
  if (rest.startsWith("jobs/") && method === "DELETE") {
    store.require(project, user.id, "edit");
    const id = rest.slice(5);
    store.run(
      "UPDATE jobs SET status='cancelled' WHERE id=? AND project=? AND status IN ('queued','running')",
      id,
      project,
    );
    collab.changed(project);
    return { ok: true };
  }
  fail(404, "接口不存在");
}
