/**
 * PostgreSQL access. Production uses a real server (`postgres://…`); tests and single-user
 * trials can use PGlite (`pglite:<dir>` or `pglite:memory`), the same engine compiled to WASM.
 *
 * Rule: inside `transaction(tx => …)` use only `tx`. PGlite has one connection, so touching the
 * outer database from inside a transaction would wait for that transaction forever.
 */
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export type Query = { text: string; values: unknown[] };
/** `sql\`SELECT … WHERE id=${id}\`` becomes a parameterised query; values are never inlined. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Query {
  let text = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1] ?? ""}`;
  return { text, values };
}
export interface Sql {
  rows<T>(query: Query): Promise<T[]>;
  row<T>(query: Query): Promise<T | undefined>;
  /** Returns the number of affected rows. */
  run(query: Query): Promise<number>;
  /** Runs trusted multi-statement SQL such as migrations. */
  exec(text: string): Promise<void>;
}
export interface Database extends Sql {
  readonly kind: "postgres" | "pglite";
  transaction<T>(action: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export const uniqueViolation = (error: unknown) =>
  !!error && typeof error === "object" && (error as { code?: unknown }).code === "23505";

type Runner = (text: string, values: unknown[]) => Promise<{ rows: unknown[]; count: number }>;
function wrap(run: Runner, exec: (text: string) => Promise<void>): Sql {
  return {
    rows: async <T>(q: Query) => (await run(q.text, q.values)).rows as T[],
    row: async <T>(q: Query) => (await run(q.text, q.values)).rows[0] as T | undefined,
    run: async (q: Query) => (await run(q.text, q.values)).count,
    exec,
  };
}

// Millisecond timestamps and counts fit in a JS number; keep int8 consistent with PGlite.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));

function postgres(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // An idle client losing its connection must not crash the process.
  pool.on("error", (error) => console.error("PostgreSQL idle client error:", error.message));
  const of = (client: pg.Pool | pg.PoolClient) =>
    wrap(
      async (text, values) => {
        const result = await client.query(text, values);
        return { rows: result.rows, count: result.rowCount ?? 0 };
      },
      async (text) => {
        await client.query(text);
      },
    );
  return {
    kind: "postgres",
    ...of(pool),
    async transaction(action) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await action(of(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pglite(location: string): Promise<Database> {
  const db = new PGlite(location === "memory" ? undefined : location);
  await db.waitReady;
  const of = (client: Pick<PGlite, "query" | "exec">) =>
    wrap(
      async (text, values) => {
        const result = await client.query(text, values);
        return { rows: result.rows, count: result.affectedRows ?? 0 };
      },
      async (text) => {
        await client.exec(text);
      },
    );
  return {
    kind: "pglite",
    ...of(db),
    transaction: (action) => db.transaction((tx) => action(of(tx))),
    close: () => db.close(),
  };
}

/** Ordered, append-only schema history. Never edit an applied entry; add a new one. */
export const migrations: string[] = [
  `CREATE TABLE users(
     id TEXT PRIMARY KEY,
     username TEXT UNIQUE NOT NULL,
     password TEXT NOT NULL,
     admin BOOLEAN NOT NULL DEFAULT false,
     created BIGINT NOT NULL
   );
   CREATE TABLE sessions(
     token TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires BIGINT NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, created BIGINT NOT NULL);
   CREATE TABLE members(
     project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     PRIMARY KEY(project, user_id)
   );
   CREATE INDEX members_user ON members(user_id);
   CREATE TABLE invites(
     token TEXT PRIMARY KEY,
     project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     expires BIGINT NOT NULL,
     used BOOLEAN NOT NULL DEFAULT false
   );
   CREATE TABLE files(
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     state BYTEA NOT NULL,
     is_binary BOOLEAN NOT NULL,
     deleted BOOLEAN NOT NULL DEFAULT false,
     revision INTEGER NOT NULL DEFAULT 1,
     UNIQUE(project, path)
   );
   CREATE TABLE file_updates(
     id BIGSERIAL PRIMARY KEY,
     file TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
     data BYTEA NOT NULL,
     created BIGINT NOT NULL
   );
   CREATE INDEX file_updates_file ON file_updates(file, id);
   CREATE TABLE comments(
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     file TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
     author TEXT NOT NULL REFERENCES users(id),
     quote TEXT NOT NULL,
     start_pos TEXT NOT NULL,
     end_pos TEXT NOT NULL,
     body TEXT NOT NULL,
     resolved BOOLEAN NOT NULL DEFAULT false,
     created BIGINT NOT NULL,
     updated BIGINT NOT NULL
   );
   CREATE INDEX comments_project ON comments(project, created);
   CREATE TABLE replies(
     id TEXT PRIMARY KEY,
     comment TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
     author TEXT NOT NULL REFERENCES users(id),
     body TEXT NOT NULL,
     created BIGINT NOT NULL
   );
   CREATE INDEX replies_comment ON replies(comment, created);
   CREATE TABLE snapshots(
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     label TEXT NOT NULL,
     author TEXT NOT NULL REFERENCES users(id),
     created BIGINT NOT NULL,
     manual BOOLEAN NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX snapshots_project ON snapshots(project, created);
   CREATE TABLE audit(
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     detail TEXT NOT NULL,
     created BIGINT NOT NULL
   );
   CREATE INDEX audit_project ON audit(project, created);
   CREATE TABLE proposals(
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     file TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
     author TEXT NOT NULL,
     base TEXT NOT NULL,
     proposed TEXT NOT NULL,
     hunks TEXT NOT NULL,
     revision INTEGER NOT NULL DEFAULT 1,
     created BIGINT NOT NULL
   );
   CREATE INDEX proposals_project ON proposals(project, created);
   CREATE TABLE jobs(
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     author TEXT NOT NULL,
     prompt TEXT NOT NULL,
     harness TEXT NOT NULL,
     status TEXT NOT NULL,
     runner TEXT,
     lease BIGINT,
     result TEXT NOT NULL DEFAULT '',
     created BIGINT NOT NULL,
     base TEXT NOT NULL
   );
   CREATE INDEX jobs_queue ON jobs(project, status, created);
   CREATE TABLE runners(
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     token TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     capabilities TEXT NOT NULL DEFAULT '[]'
   );`,
  // 2: account administration for lab deployments.
  `ALTER TABLE users ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT false;
   ALTER TABLE users ADD COLUMN must_change BOOLEAN NOT NULL DEFAULT false;`,
  // 3: server-side LaTeX builds (latest two per project are kept).
  `CREATE TABLE builds(
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     author TEXT NOT NULL,
     main TEXT NOT NULL,
     engine TEXT NOT NULL,
     status TEXT NOT NULL,
     issues TEXT NOT NULL,
     log TEXT NOT NULL,
     pdf BYTEA,
     synctex BYTEA,
     build_dir TEXT NOT NULL,
     duration INTEGER NOT NULL,
     created BIGINT NOT NULL
   );
   CREATE INDEX builds_project ON builds(project, created);`,
  // 4: named device tokens (desktop sync) live beside browser sessions.
  `ALTER TABLE sessions ADD COLUMN name TEXT;
   ALTER TABLE sessions ADD COLUMN created BIGINT;
   ALTER TABLE sessions ADD COLUMN used BIGINT;`,
  // 5: self-registration awaiting approval, deleted accounts, site invitations and settings.
  `ALTER TABLE users ADD COLUMN pending BOOLEAN NOT NULL DEFAULT false;
   ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT '';
   ALTER TABLE users ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT false;
   ALTER TABLE invites ADD COLUMN created_by TEXT;
   CREATE TABLE signup_invites(
     id TEXT PRIMARY KEY,
     token TEXT NOT NULL UNIQUE,
     note TEXT NOT NULL DEFAULT '',
     created_by TEXT NOT NULL,
     created BIGINT NOT NULL,
     expires BIGINT NOT NULL,
     uses INTEGER NOT NULL,
     used INTEGER NOT NULL DEFAULT 0,
     revoked BOOLEAN NOT NULL DEFAULT false
   );
   CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // 6: project dashboard — when a project last changed, and each member's archive and trash.
  `ALTER TABLE projects ADD COLUMN updated BIGINT NOT NULL DEFAULT 0;
   UPDATE projects p SET updated=GREATEST(p.created,
     coalesce((SELECT max(a.created) FROM audit a WHERE a.project=p.id), 0));
   ALTER TABLE members ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
   ALTER TABLE members ADD COLUMN trashed BIGINT;`,
  // 7: comments made on the PDF keep their highlight; comments and replies record edits.
  `ALTER TABLE comments ADD COLUMN pdf TEXT;
   ALTER TABLE comments ADD COLUMN edited BIGINT;
   ALTER TABLE replies ADD COLUMN edited BIGINT;`,
];

/** Applies pending migrations atomically; concurrent starts wait on an advisory lock. */
export async function migrate(db: Database) {
  await db.transaction(async (tx) => {
    await tx.rows(sql`SELECT pg_advisory_xact_lock(${7_377_001})`);
    await tx.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied BIGINT NOT NULL)",
    );
    const done =
      (
        await tx.row<{ version: number | null }>(
          sql`SELECT max(version) AS version FROM schema_migrations`,
        )
      )?.version ?? 0;
    if (done > migrations.length)
      throw new Error(`数据库结构版本 ${done} 比当前程序新，请升级 Writer 后再启动`);
    for (let version = done + 1; version <= migrations.length; version++) {
      await tx.exec(migrations[version - 1] ?? "");
      await tx.run(
        sql`INSERT INTO schema_migrations(version, applied) VALUES(${version}, ${Date.now()})`,
      );
    }
  });
}

/** `postgres://…`, `postgresql://…`, `pglite:/absolute/dir` or `pglite:memory`. */
export async function connect(url: string): Promise<Database> {
  let db: Database;
  if (/^postgres(ql)?:\/\//.test(url)) db = postgres(url);
  else if (url.startsWith("pglite:")) db = await pglite(url.slice("pglite:".length) || "memory");
  else throw new Error("WRITER_DATABASE_URL 必须以 postgres://、postgresql:// 或 pglite: 开头");
  try {
    await migrate(db);
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
  return db;
}
