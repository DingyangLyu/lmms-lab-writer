/**
 * One-time import of a Writer collaboration SQLite database (versions before PostgreSQL).
 * Usage: pnpm --filter @lmms-lab/writer-collaboration migrate-sqlite /path/writer.sqlite
 * The target is WRITER_DATABASE_URL (or the default embedded database) and must be empty.
 */
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import "./environment";
import { connect, type Database, sql } from "./db";

type Row = Record<string, unknown>;
const bool = (value: unknown) => value === true || Number(value) === 1;

export async function importSqlite(file: string, db: Database) {
  const source = new DatabaseSync(file, { readOnly: true });
  const all = (table: string): Row[] => {
    const exists = source
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    return exists ? (source.prepare(`SELECT * FROM ${table}`).all() as Row[]) : [];
  };
  const counts: Record<string, number> = {};
  try {
    await db.transaction(async (tx) => {
      if (await tx.row(sql`SELECT 1 FROM users LIMIT 1`))
        throw new Error("目标数据库已有账号，拒绝重复导入。请使用新的空数据库。");
      const now = Date.now();
      const steps: Array<[string, (row: Row) => Promise<unknown>]> = [
        [
          "users",
          (r) =>
            tx.run(sql`INSERT INTO users(id, username, password, admin, created)
              VALUES(${r.id}, ${r.username}, ${r.password}, ${bool(r.admin)}, ${now})`),
        ],
        [
          "projects",
          (r) =>
            tx.run(
              sql`INSERT INTO projects(id, name, created) VALUES(${r.id}, ${r.name}, ${r.created})`,
            ),
        ],
        [
          "members",
          (r) =>
            tx.run(
              sql`INSERT INTO members(project, user_id, role) VALUES(${r.project}, ${r.user}, ${r.role})`,
            ),
        ],
        [
          "invites",
          (r) =>
            tx.run(sql`INSERT INTO invites(token, project, role, expires, used)
              VALUES(${r.token}, ${r.project}, ${r.role}, ${r.expires}, ${bool(r.used)})`),
        ],
        [
          "sessions",
          (r) =>
            tx.run(
              sql`INSERT INTO sessions(token, user_id, expires) VALUES(${r.token}, ${r.user}, ${r.expires})`,
            ),
        ],
        [
          "files",
          (r) =>
            tx.run(sql`INSERT INTO files(id, project, path, state, is_binary, deleted, revision)
              VALUES(${r.id}, ${r.project}, ${r.path}, ${new Uint8Array(r.state as Uint8Array)},
                     ${bool(r.binary)}, ${bool(r.deleted)}, ${r.revision})`),
        ],
        [
          "comments",
          (r) =>
            tx.run(sql`INSERT INTO comments(id, project, file, author, quote, start_pos, end_pos, body, resolved, created, updated)
              VALUES(${r.id}, ${r.project}, ${r.file}, ${r.author}, ${r.quote}, ${r.start}, ${r.end},
                     ${r.body}, ${bool(r.resolved)}, ${r.created}, ${r.updated})`),
        ],
        [
          "replies",
          (r) =>
            tx.run(sql`INSERT INTO replies(id, comment, author, body, created)
              VALUES(${r.id}, ${r.comment}, ${r.author}, ${r.body}, ${r.created})`),
        ],
        [
          "snapshots",
          (r) =>
            tx.run(sql`INSERT INTO snapshots(id, project, label, author, created, manual, data)
              VALUES(${r.id}, ${r.project}, ${r.label}, ${r.author}, ${r.created},
                     ${r.manual === undefined ? true : bool(r.manual)}, ${r.data})`),
        ],
        [
          "audit",
          (r) =>
            tx.run(sql`INSERT INTO audit(id, project, actor, action, detail, created)
              VALUES(${r.id}, ${r.project}, ${r.actor}, ${r.action}, ${r.detail}, ${r.created})`),
        ],
        [
          "proposals",
          (r) =>
            tx.run(sql`INSERT INTO proposals(id, project, file, author, base, proposed, hunks, revision, created)
              VALUES(${r.id}, ${r.project}, ${r.file}, ${r.author}, ${r.base}, ${r.proposed},
                     ${r.hunks}, ${r.revision}, ${r.created})`),
        ],
        [
          "jobs",
          (r) =>
            tx.run(sql`INSERT INTO jobs(id, project, author, prompt, harness, status, runner, lease, result, created, base)
              VALUES(${r.id}, ${r.project}, ${r.author}, ${r.prompt}, ${r.harness},
                     ${r.status === "queued" || r.status === "running" ? "failed" : r.status},
                     ${r.runner}, ${r.lease},
                     ${r.status === "queued" || r.status === "running" ? "数据库迁移时中断，可重新提交" : r.result},
                     ${r.created}, ${r.base})`),
        ],
        [
          "runners",
          (r) =>
            tx.run(sql`INSERT INTO runners(id, project, token, name, capabilities)
              VALUES(${r.id}, ${r.project}, ${r.token}, ${r.name}, ${r.capabilities})`),
        ],
      ];
      for (const [table, insert] of steps) {
        const rows = all(table);
        counts[table] = rows.length;
        for (const row of rows) await insert(row);
      }
    });
  } finally {
    source.close();
  }
  return counts;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const file = process.argv[2];
  if (!file) throw new Error("用法：pnpm migrate-sqlite /path/writer.sqlite");
  const url =
    process.env.WRITER_DATABASE_URL ||
    `pglite:${resolve(process.env.WRITER_DATA_DIR || ".data", "postgres")}`;
  const db = await connect(url);
  try {
    const counts = await importSqlite(resolve(file), db);
    console.log(`已导入 ${resolve(file)} → ${db.kind}`);
    for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`);
  } finally {
    await db.close();
  }
}
