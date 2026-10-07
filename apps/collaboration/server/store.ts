import * as Y from "yjs";
import { connect, type Database, type Sql, sql } from "./db";
import { type Access, allows, decodeText, fail, type Role, uid } from "./util";

export type User = { id: string; username: string; password: string; admin: boolean };
export type FileMeta = {
  id: string;
  project: string;
  path: string;
  binary: boolean;
  deleted: boolean;
  revision: number;
};
/** `state` is the compacted base merged with every update appended after it. */
export type FileRow = FileMeta & { state: Uint8Array };
export const AUTOMATIC_SNAPSHOTS = 50;
const meta = `id, project, path, is_binary AS "binary", deleted, revision`;
const bytes = (value: Uint8Array) => (value instanceof Uint8Array ? value : new Uint8Array(value));
const merged = (state: Uint8Array, updates: Uint8Array[]) =>
  updates.length ? Y.mergeUpdates([state, ...updates]) : state;

export class Store {
  constructor(public db: Database) {}
  static async open(url: string) {
    return new Store(await connect(url));
  }
  async role(project: string, user: string, q: Sql = this.db): Promise<Role> {
    return (
      (
        await q.row<{ role: Role }>(
          sql`SELECT role FROM members WHERE project=${project} AND user_id=${user}`,
        )
      )?.role ?? fail(403, "无权访问此项目")
    );
  }
  async require(project: string, user: string, minimum: Access = "read", q: Sql = this.db) {
    const role = await this.role(project, user, q);
    if (!allows(role, minimum)) fail(403, "当前角色不允许此操作");
    return role;
  }
  /** Non-throwing permission check for background work such as queued AI tasks. */
  async can(project: string, user: string, minimum: Access, q: Sql = this.db) {
    const row = await q.row<{ role: Role }>(
      sql`SELECT role FROM members WHERE project=${project} AND user_id=${user}`,
    );
    return !!row && allows(row.role, minimum);
  }
  /** A deleted file keeps its row for history, but must not reserve its path forever. */
  async releasePath(project: string, path: string, q: Sql = this.db) {
    await q.run(
      sql`UPDATE files SET path='.deleted/'||id||'/'||path WHERE project=${project} AND path=${path} AND deleted`,
    );
  }
  async fileMeta(project: string, id: string, q: Sql = this.db): Promise<FileMeta> {
    return (
      (await q.row<FileMeta>({
        text: `SELECT ${meta} FROM files WHERE project=$1 AND id=$2 AND NOT deleted`,
        values: [project, id],
      })) ?? fail(404, "文档不存在")
    );
  }
  async fileExists(project: string, id: string, q: Sql = this.db) {
    return !!(await q.row(
      sql`SELECT 1 FROM files WHERE project=${project} AND id=${id} AND NOT deleted`,
    ));
  }
  async fileState(id: string, q: Sql = this.db) {
    const base = await q.row<{ state: Uint8Array }>(sql`SELECT state FROM files WHERE id=${id}`);
    if (!base) fail(404, "文档不存在");
    const updates = await q.rows<{ data: Uint8Array }>(
      sql`SELECT data FROM file_updates WHERE file=${id} ORDER BY id`,
    );
    return merged(
      bytes(base.state),
      updates.map((u) => bytes(u.data)),
    );
  }
  async file(project: string, id: string, q: Sql = this.db): Promise<FileRow> {
    const row = await this.fileMeta(project, id, q);
    return { ...row, state: await this.fileState(id, q) };
  }
  /** Every acknowledged edit is one small row; compaction folds them into `files.state`. */
  async appendUpdate(file: string, update: Uint8Array, q: Sql = this.db) {
    await q.run(
      sql`INSERT INTO file_updates(file, data, created) VALUES(${file}, ${update}, ${Date.now()})`,
    );
  }
  async pending(file: string, q: Sql = this.db) {
    return (
      (await q.row<{ count: number; bytes: number }>(
        sql`SELECT count(*) AS count, coalesce(sum(length(data)),0) AS bytes FROM file_updates WHERE file=${file}`,
      )) ?? { count: 0, bytes: 0 }
    );
  }
  /** Callers serialise appends to `file` (the collaboration room lock) while compacting. */
  async compact(file: string) {
    await this.db.transaction(async (tx) => {
      const base = await tx.row<{ state: Uint8Array }>(
        sql`SELECT state FROM files WHERE id=${file} FOR UPDATE`,
      );
      const updates = await tx.rows<{ id: number; data: Uint8Array }>(
        sql`SELECT id, data FROM file_updates WHERE file=${file} ORDER BY id`,
      );
      const last = updates.at(-1);
      if (!base || !last) return;
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, bytes(base.state));
        for (const u of updates) Y.applyUpdate(doc, bytes(u.data));
        await tx.run(
          sql`UPDATE files SET state=${Y.encodeStateAsUpdate(doc)}, revision=revision+1 WHERE id=${file}`,
        );
      } finally {
        doc.destroy();
      }
      await tx.run(sql`DELETE FROM file_updates WHERE file=${file} AND id<=${last.id}`);
    });
  }
  /** All files of a project with their merged states, in two queries. */
  async projectFiles(project: string, q: Sql = this.db, includeDeleted = false) {
    const rows = await q.rows<FileRow>({
      text: `SELECT ${meta}, state FROM files WHERE project=$1 ${includeDeleted ? "" : "AND NOT deleted"} ORDER BY path`,
      values: [project],
    });
    const updates = await q.rows<{ file: string; data: Uint8Array }>(
      sql`SELECT u.file, u.data FROM file_updates u JOIN files f ON f.id=u.file WHERE f.project=${project} ORDER BY u.id`,
    );
    const pending = new Map<string, Uint8Array[]>();
    for (const u of updates) pending.set(u.file, [...(pending.get(u.file) ?? []), bytes(u.data)]);
    return rows.map((f) => ({ ...f, state: merged(bytes(f.state), pending.get(f.id) ?? []) }));
  }
  async textFiles(project: string, q: Sql = this.db) {
    return (await this.projectFiles(project, q))
      .filter((f) => !f.binary)
      .map((f) => ({ id: f.id, path: f.path, content: decodeText(f.state), revision: f.revision }));
  }
  async audit(project: string, actor: string, action: string, detail: unknown, q: Sql = this.db) {
    await q.run(
      sql`INSERT INTO audit(id, project, actor, action, detail, created)
          VALUES(${uid()}, ${project}, ${actor}, ${action}, ${JSON.stringify(detail)}, ${Date.now()})`,
    );
  }
  /** Automatic safety versions are bounded; manual versions are never pruned. */
  async snapshot(project: string, user: string, label: string, manual = false, q: Sql = this.db) {
    const id = uid();
    const files = await this.projectFiles(project, q, true);
    const comments = await q.rows(
      sql`SELECT id, project, file, author, quote, start_pos AS start, end_pos AS "end", body, resolved, created, updated
          FROM comments WHERE project=${project}`,
    );
    const replies = await q.rows(
      sql`SELECT r.* FROM replies r JOIN comments c ON r.comment=c.id WHERE c.project=${project}`,
    );
    const data = JSON.stringify({
      files: files.map((f) => ({
        id: f.id,
        path: f.path,
        binary: f.binary,
        deleted: f.deleted,
        revision: f.revision,
        state: Buffer.from(f.state).toString("base64"),
      })),
      comments,
      replies,
    });
    if (Buffer.byteLength(data) > 150_000_000) fail(413, "项目快照过大");
    await q.run(
      sql`INSERT INTO snapshots(id, project, label, author, created, manual, data)
          VALUES(${id}, ${project}, ${label}, ${user}, ${Date.now()}, ${manual}, ${data})`,
    );
    if (!manual)
      await q.run(
        sql`DELETE FROM snapshots WHERE project=${project} AND NOT manual
              AND id NOT IN (SELECT base FROM jobs WHERE project=${project} AND status IN ('queued','running'))
              AND id NOT IN (SELECT id FROM snapshots WHERE project=${project} AND NOT manual
                             ORDER BY created DESC, id DESC LIMIT ${AUTOMATIC_SNAPSHOTS})`,
      );
    return id;
  }
  close() {
    return this.db.close();
  }
}
