/**
 * Whole-file changes merged into a project's shared text in a member's name: an AI agent's
 * edits (agents.ts) or a Git pull (git.ts). Each change carries the text it was based on, so
 * work a collaborator did meanwhile is kept; where both changed the same lines, the change
 * becomes a reviewable suggestion instead.
 */
import { mergeText, reviewHunks } from "@lmms-lab/writing";
import type { AgentChangeResult } from "../shared/agents";
import type { ChangeAuthor } from "../shared/tracked";
import type { Collaboration } from "./collaboration";
import { sql } from "./db";
import { createFile, PROJECT_BYTES, projectTooLarge } from "./routes/files";
import type { Store } from "./store";
import { checked, fail, HttpError, isTextPath, normalizeEol, safePath, uid } from "./util";

type Params = Record<string, unknown>;
const isObject = (value: unknown): value is Params =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (body: Params, key: string, max: number) =>
  typeof body[key] === "string" && body[key].length <= max
    ? (body[key] as string)
    : fail(400, "无效字段 {key}", { key });

/** Each change on its own: one that cannot be applied does not hold back the others. */
export async function applyFileChanges(
  store: Store,
  collab: Collaboration,
  project: string,
  actor: string,
  raw: unknown,
  track?: ChangeAuthor,
) {
  if (!Array.isArray(raw) || raw.length > 200) fail(400, "AI 改动无效");
  const results: AgentChangeResult[] = [];
  for (const value of raw) {
    if (!isObject(value)) fail(400, "AI 改动无效");
    const path = safePath(text(value, "path", 240));
    try {
      results.push(await applyChange(store, collab, project, actor, path, value, track));
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      results.push({ path, status: "skipped", reason: error.template });
    }
  }
  return results;
}
async function applyChange(
  store: Store,
  collab: Collaboration,
  project: string,
  actor: string,
  path: string,
  change: Params,
  track?: ChangeAuthor,
): Promise<AgentChangeResult> {
  const file = await store.db.row<{ id: string; binary: boolean; revision: number }>(
    sql`SELECT id, is_binary AS "binary", revision FROM files
        WHERE project=${project} AND path=${path} AND NOT deleted`,
  );
  // An agent on Windows may write "\r\n"; the shared text has "\n" only.
  const base = typeof change.base === "string" ? normalizeEol(change.base) : null;
  if (typeof change.content === "string") change.content = normalizeEol(change.content);
  const revision = typeof change.revision === "number" ? change.revision : null;
  if (change.deleted === true) {
    if (!file) return { path, status: "applied" };
    const unchanged = file.binary
      ? revision === file.revision
      : (await collab.text(project, file.id)) === base;
    // Someone else's newer work is never deleted.
    if (!unchanged) return { path, status: "skipped", reason: "文件已被其他人修改，未删除" };
    await store.db.transaction(async (tx) => {
      await tx.run(sql`UPDATE files SET deleted=true WHERE id=${file.id}`);
      await store.audit(project, actor, "file.delete", { file: file.id, path, agent: true }, tx);
    });
    collab.closeFile(file.id, "文件已删除");
    return { path, status: "applied" };
  }
  if (typeof change.content === "string") {
    if (!isTextPath(path) || file?.binary)
      return { path, status: "skipped", reason: "文件类型已改变" };
    if (Buffer.byteLength(change.content) > 2_000_000) fail(413, "文本文件超过 2 MB");
    if (!file) {
      await createFile(store, project, actor, path, change.content);
      return { path, status: "applied" };
    }
    // A collaborator may type between reading and replacing; try again with the new text.
    for (let attempt = 0; ; attempt++) {
      const current = await collab.text(project, file.id);
      const merged = mergeText(base ?? "", current, change.content);
      if (merged.content === null) {
        await propose(store, project, file.id, actor, base ?? "", change.content);
        return { path, status: "proposal" };
      }
      if (merged.content === current) return { path, status: "applied" };
      try {
        await collab.replaceMany(
          project,
          [{ file: file.id, expected: current, content: merged.content }],
          actor,
          undefined,
          track,
        );
        return { path, status: "applied" };
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 409 || attempt >= 2) throw error;
      }
    }
  }
  if (typeof change.base64 === "string") {
    if (isTextPath(path) || (file && !file.binary))
      return { path, status: "skipped", reason: "文件类型已改变" };
    if (change.base64.length > 14_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(change.base64))
      fail(400, "无效文件编码");
    const bytes = Buffer.from(change.base64, "base64");
    if (bytes.length > 10_000_000) fail(413, "单文件超过 10 MB");
    if (!file) {
      const created = await createFile(store, project, actor, path, bytes);
      return { path, status: "applied", revision: created.revision };
    }
    if (revision !== file.revision)
      return { path, status: "skipped", reason: "文件已被其他人替换" };
    const saved = await store.db.transaction(async (tx) => {
      const size = await tx.row<{ bytes: number }>(
        sql`SELECT coalesce(sum(length(state)),0) AS bytes FROM files WHERE project=${project} AND id<>${file.id}`,
      );
      if ((size?.bytes ?? 0) + bytes.length > PROJECT_BYTES) projectTooLarge();
      const row =
        (await tx.row<{ revision: number }>(
          sql`UPDATE files SET state=${bytes}, revision=revision+1
              WHERE id=${file.id} AND revision=${file.revision} AND NOT deleted RETURNING revision`,
        )) ?? fail(409, "文件已被其他人替换");
      await store.audit(project, actor, "file.replace", { file: file.id, path, agent: true }, tx);
      return row.revision;
    });
    return { path, status: "applied", revision: saved };
  }
  return fail(400, "AI 改动无效");
}
/** Overlapping edits stay reviewable hunk by hunk, as a member's suggestion would. */
async function propose(
  store: Store,
  project: string,
  file: string,
  actor: string,
  base: string,
  proposed: string,
) {
  const id = uid(),
    hunks = checked(() => reviewHunks(base, proposed));
  await store.db.transaction(async (tx) => {
    await tx.run(
      sql`INSERT INTO proposals(id, project, file, author, base, proposed, hunks, revision, created)
          VALUES(${id}, ${project}, ${file}, ${actor}, ${base}, ${proposed}, ${JSON.stringify(hunks)}, 1, ${Date.now()})`,
    );
    await store.audit(project, actor, "proposal.create", { id, file, agent: true }, tx);
  });
}
