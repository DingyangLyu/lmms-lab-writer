import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { reviewHunks } from "@lmms-lab/writing";
import * as Y from "yjs";
import type { Collaboration } from "./collaboration";
import { sql } from "./db";
import type { Store, User } from "./store";
import { checked, decodeText, digest, fail, type Role, safePath, textDoc, uid } from "./util";

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
  files: {
    id: string;
    path: string;
    state: string;
    binary: boolean | number;
    deleted: boolean | number;
  }[];
};
const PROJECT_FILES = 2000,
  PROJECT_BYTES = 100_000_000;
const text = (body: Body, key: string, max = 10000) =>
  typeof body[key] === "string" && body[key].length <= max
    ? (body[key] as string)
    : fail(400, `无效字段 ${key}`);
export async function runnerRequest(
  store: Store,
  collab: Collaboration,
  req: IncomingMessage,
  path: string,
  body: Body,
) {
  const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
  const runner =
    (await store.db.row<Runner>(sql`SELECT * FROM runners WHERE token=${digest(token)}`)) ??
    fail(401, "Runner 凭据无效");
  if (path === "/api/runner/lease") {
    const caps = JSON.parse(runner.capabilities) as string[];
    await store.db.run(
      sql`UPDATE jobs SET status='failed', result='执行器失联，可重新提交任务'
          WHERE project=${runner.project} AND status='running' AND lease<${Date.now()}`,
    );
    let changed = false;
    const leased = await store.db.transaction(async (tx) => {
      const jobs = await tx.rows<Job>(
        sql`SELECT * FROM jobs WHERE project=${runner.project} AND status='queued' ORDER BY created LIMIT 50`,
      );
      for (const job of jobs) {
        if (!caps.includes(job.harness.startsWith("compile:") ? "compile" : job.harness)) continue;
        // A task that can never run must not block every task queued behind it.
        const snapshot = await tx.row<{ data: string }>(
          sql`SELECT data FROM snapshots WHERE id=${job.base} AND project=${job.project}`,
        );
        const blocked = !(await store.can(job.project, job.author, "edit", tx))
          ? "提交者已无编辑权限，任务未执行"
          : !snapshot
            ? "任务输入版本已不存在，请重新提交"
            : null;
        if (blocked || !snapshot) {
          await tx.run(
            sql`UPDATE jobs SET status='failed', result=${blocked} WHERE id=${job.id} AND status='queued'`,
          );
          changed = true;
          continue;
        }
        // Another runner may have claimed it since the SELECT; only one update can win.
        const claimed = await tx.run(
          sql`UPDATE jobs SET status='running', runner=${runner.id}, lease=${Date.now() + 60000}
              WHERE id=${job.id} AND status='queued'`,
        );
        if (!claimed) continue;
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
        changed = true;
        return { job: { ...job, status: "running", files } };
      }
      return { job: null };
    });
    if (changed) collab.changed(runner.project);
    return leased;
  }
  const id = text(body, "id", 80),
    job =
      (await store.db.row<Job>(
        sql`SELECT * FROM jobs WHERE id=${id} AND project=${runner.project} AND runner=${runner.id}`,
      )) ?? fail(404, "任务不存在");
  if (job.status !== "running") fail(409, "任务已结束或取消");
  if (!(await store.can(job.project, job.author, "edit"))) {
    await store.db.run(
      sql`UPDATE jobs SET status='failed', result='提交者已无编辑权限，结果未提交' WHERE id=${id}`,
    );
    collab.changed(job.project);
    fail(409, "提交者已无编辑权限");
  }
  if (path === "/api/runner/heartbeat") {
    await store.db.run(
      sql`UPDATE jobs SET lease=${Date.now() + 60000} WHERE id=${id} AND status='running'`,
    );
    return { ok: true };
  }
  if (path !== "/api/runner/result") fail(404, "接口不存在");
  const result = text(body, "result", 50000),
    error = body.error === true;
  if (error) {
    await store.db.run(
      sql`UPDATE jobs SET status='failed', result=${result} WHERE id=${id} AND status='running'`,
    );
    collab.changed(job.project);
    return { ok: true };
  }
  const raw = body.files;
  if (!Array.isArray(raw) || raw.length > 200) fail(400, "任务输出文件无效");
  const snapshot =
    (await store.db.row<{ data: string }>(sql`SELECT data FROM snapshots WHERE id=${job.base}`)) ??
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
  const usage = (await store.db.row<{ count: number; bytes: number }>(
    sql`SELECT count(*) AS count, coalesce(sum(length(state)),0) AS bytes FROM files WHERE project=${job.project}`,
  )) ?? { count: 0, bytes: 0 };
  const added = files.filter((f) => f.binary);
  if (
    usage.count + added.length > PROJECT_FILES ||
    usage.bytes + added.reduce((n, f) => n + (f.binary?.length ?? 0), 0) > PROJECT_BYTES
  )
    fail(413, `项目超过 ${PROJECT_FILES} 个文件或 100 MB，产物未保存`);
  const ids: string[] = [];
  await store.db.transaction(async (tx) => {
    // Cancellation can race with the result; only a still-running task may complete.
    const finished = await tx.run(
      sql`UPDATE jobs SET status='completed', result=${result} WHERE id=${id} AND status='running'`,
    );
    if (!finished) fail(409, "任务已结束或取消");
    for (const f of files) {
      if (f.binary) {
        // Generated assets are new artifacts, never an overwrite of a collaborator's file.
        const path = `artifacts/${job.id}/${f.path}`;
        if (path.length > 240) fail(400, "产物路径过长");
        await store.releasePath(job.project, path, tx);
        await tx.run(
          sql`INSERT INTO files(id, project, path, state, is_binary) VALUES(${uid()}, ${job.project}, ${path}, ${f.binary}, true)`,
        );
        continue;
      }
      const old = baseline.find((old) => old.path === f.path && !old.deleted);
      if (old?.binary) fail(400, "不能用文本覆盖二进制文件");
      const base = old ? decodeText(Buffer.from(old.state, "base64")) : "";
      if (base === f.content) continue;
      // Follow the snapshot's file ID so a collaborator's rename during the task keeps the
      // proposal on the same document instead of creating an empty copy at the old path.
      let file =
        (old &&
          (await tx.row<{ id: string; binary: boolean }>(
            sql`SELECT id, is_binary AS "binary" FROM files WHERE project=${job.project} AND id=${old.id} AND NOT deleted`,
          ))) ||
        (await tx.row<{ id: string; binary: boolean }>(
          sql`SELECT id, is_binary AS "binary" FROM files WHERE project=${job.project} AND path=${f.path} AND NOT deleted`,
        ));
      if (file?.binary) fail(400, "不能用文本覆盖二进制文件");
      if (!file) {
        const created = uid(),
          doc = textDoc("");
        await store.releasePath(job.project, f.path, tx);
        await tx.run(
          sql`INSERT INTO files(id, project, path, state, is_binary)
              VALUES(${created}, ${job.project}, ${f.path}, ${Y.encodeStateAsUpdate(doc)}, false)`,
        );
        doc.destroy();
        file = { id: created, binary: false };
      }
      const proposal = uid(),
        hunks = checked(() => reviewHunks(base, f.content || ""));
      await tx.run(
        sql`INSERT INTO proposals(id, project, file, author, base, proposed, hunks, revision, created)
            VALUES(${proposal}, ${job.project}, ${file.id}, ${job.author}, ${base}, ${f.content || ""},
                   ${JSON.stringify(hunks)}, 1, ${Date.now()})`,
      );
      ids.push(proposal);
    }
    await store.audit(
      job.project,
      job.author,
      "task.completed",
      { id, runner: runner.name, proposals: ids },
      tx,
    );
  });
  collab.changed(job.project);
  return { ok: true, proposals: ids };
}
export async function projectJobs(
  store: Store,
  collab: Collaboration,
  project: string,
  user: User,
  _role: Role,
  rest: string,
  method: string,
  body: Body,
): Promise<unknown> {
  if (rest === "runners" && method === "POST") {
    await store.require(project, user.id, "owner");
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
    await store.db.run(
      sql`INSERT INTO runners(id, project, token, name, capabilities)
          VALUES(${id}, ${project}, ${digest(token)}, ${name}, ${JSON.stringify(capabilities)})`,
    );
    return { id, token };
  }
  if (rest === "runners" && method === "GET") {
    await store.require(project, user.id, "owner");
    return store.db.rows(sql`SELECT id, name, capabilities FROM runners WHERE project=${project}`);
  }
  if (rest.startsWith("runners/") && method === "DELETE") {
    await store.require(project, user.id, "owner");
    await store.db.run(sql`DELETE FROM runners WHERE project=${project} AND id=${rest.slice(8)}`);
    return { ok: true };
  }
  if (rest === "jobs" && method === "GET")
    return store.db.rows(
      sql`SELECT id, author, prompt, harness, status, result, created FROM jobs
          WHERE project=${project} ORDER BY created DESC LIMIT 100`,
    );
  if (rest === "jobs" && method === "POST") {
    await store.require(project, user.id, "edit");
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
      (
        await store.db.row<{ n: number }>(
          sql`SELECT count(*) AS n FROM jobs WHERE project=${project} AND status IN ('queued','running')`,
        )
      )?.n ?? 0;
    if (count >= 10) fail(429, "本项目最多 10 个排队/执行中的任务");
    const id = uid();
    await store.db.transaction(async (tx) => {
      const snapshot = await store.snapshot(project, user.id, "共享任务输入版本", false, tx);
      await tx.run(
        sql`INSERT INTO jobs(id, project, author, prompt, harness, status, created, base)
            VALUES(${id}, ${project}, ${user.id}, ${prompt}, ${harness}, 'queued', ${Date.now()}, ${snapshot})`,
      );
      await store.audit(project, user.id, "task.queued", { id, harness }, tx);
    });
    collab.changed(project);
    return { id };
  }
  if (rest.startsWith("jobs/") && method === "DELETE") {
    await store.require(project, user.id, "edit");
    await store.db.run(
      sql`UPDATE jobs SET status='cancelled'
          WHERE id=${rest.slice(5)} AND project=${project} AND status IN ('queued','running')`,
    );
    collab.changed(project);
    return { ok: true };
  }
  fail(404, "接口不存在");
}
