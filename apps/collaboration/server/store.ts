import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as Y from "yjs";
export type Role = "owner" | "editor" | "commenter" | "viewer";
export type User = { id: string; username: string; password: string; admin: number };
export type FileRow = {
  id: string;
  project: string;
  path: string;
  state: Uint8Array;
  binary: number;
  deleted: number;
  revision: number;
};
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
/** Parser and validation errors from shared writing helpers are user input errors, not 500s. */
export function checked<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, error instanceof Error ? error.message : "输入无效");
  }
}
export const uid = () => randomUUID();
export const AUTOMATIC_SNAPSHOTS = 50;
export const digest = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
export function safePath(value: string) {
  if (
    !value ||
    value.length > 240 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").some((p) => !p || p.startsWith(".")) ||
    value.includes(":") ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  )
    fail(400, "无效文件路径");
  return value;
}
/** Shared by the server and the runner so both treat the same files as editable text. */
export const textExtensions = new Set([
  "tex",
  "bib",
  "md",
  "txt",
  "sty",
  "cls",
  "bst",
  "csv",
  "json",
  "py",
  "yml",
  "yaml",
]);
export const isTextPath = (path: string) =>
  textExtensions.has(path.split(".").pop()?.toLowerCase() ?? "");
export function textDoc(value: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  return doc;
}
export function decodeText(state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}
export class Store {
  db: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "writer.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members(project TEXT NOT NULL REFERENCES projects(id),user TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(project,user));
      CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),role TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),path TEXT NOT NULL,state BLOB NOT NULL,binary INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,UNIQUE(project,path));
      CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),file TEXT NOT NULL REFERENCES files(id),author TEXT NOT NULL REFERENCES users(id),quote TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,body TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS replies(id TEXT PRIMARY KEY,comment TEXT NOT NULL REFERENCES comments(id),author TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),label TEXT NOT NULL,author TEXT NOT NULL REFERENCES users(id),created INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,project TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,project TEXT NOT NULL,file TEXT NOT NULL,author TEXT NOT NULL,base TEXT NOT NULL,proposed TEXT NOT NULL,hunks TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project TEXT NOT NULL,author TEXT NOT NULL,prompt TEXT NOT NULL,harness TEXT NOT NULL,status TEXT NOT NULL,runner TEXT,lease INTEGER,result TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,base TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runners(id TEXT PRIMARY KEY,project TEXT NOT NULL,token TEXT NOT NULL UNIQUE,name TEXT NOT NULL,capabilities TEXT NOT NULL DEFAULT '[]');
    `);
    // Older databases only had user-requested versions; keep them all as manual.
    if (
      !this.all<{ name: string }>("PRAGMA table_info(snapshots)").some((c) => c.name === "manual")
    )
      this.db.exec("ALTER TABLE snapshots ADD COLUMN manual INTEGER NOT NULL DEFAULT 1");
  }
  get<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  role(project: string, user: string): Role {
    return (
      this.get<{ role: Role }>("SELECT role FROM members WHERE project=? AND user=?", project, user)
        ?.role ?? fail(403, "无权访问此项目")
    );
  }
  require(project: string, user: string, minimum: "read" | "comment" | "edit" | "owner" = "read") {
    const role = this.role(project, user);
    const allowed =
      minimum === "read" ||
      (minimum === "comment" && role !== "viewer") ||
      (minimum === "edit" && ["owner", "editor"].includes(role)) ||
      (minimum === "owner" && role === "owner");
    if (!allowed) fail(403, "当前角色不允许此操作");
    return role;
  }
  /** A deleted file keeps its row for history, but must not reserve its path forever. */
  releasePath(project: string, path: string) {
    this.run(
      "UPDATE files SET path='.deleted/'||id||'/'||path WHERE project=? AND path=? AND deleted=1",
      project,
      path,
    );
  }
  file(project: string, id: string) {
    return (
      this.get<FileRow>(
        "SELECT * FROM files WHERE project=? AND id=? AND deleted=0",
        project,
        id,
      ) ?? fail(404, "文档不存在")
    );
  }
  /** Cheap per-message check; `file()` would load the whole document state. */
  fileExists(project: string, id: string) {
    return !!this.get("SELECT 1 FROM files WHERE project=? AND id=? AND deleted=0", project, id);
  }
  textFiles(project: string) {
    return this.all<FileRow>(
      "SELECT * FROM files WHERE project=? AND deleted=0 AND binary=0 ORDER BY path",
      project,
    ).map((f) => ({ id: f.id, path: f.path, content: decodeText(f.state), revision: f.revision }));
  }
  audit(project: string, actor: string, action: string, detail: unknown) {
    this.run(
      "INSERT INTO audit VALUES(?,?,?,?,?,?)",
      uid(),
      project,
      actor,
      action,
      JSON.stringify(detail),
      Date.now(),
    );
  }
  /** Automatic safety versions are bounded; manual versions are never pruned. */
  snapshot(project: string, user: string, label: string, manual = false) {
    const id = uid(),
      files = this.all<FileRow>("SELECT * FROM files WHERE project=?", project);
    const data = JSON.stringify({
      files: files.map((f) => ({ ...f, state: Buffer.from(f.state).toString("base64") })),
      comments: this.all("SELECT * FROM comments WHERE project=?", project),
      replies: this.all(
        "SELECT r.* FROM replies r JOIN comments c ON r.comment=c.id WHERE c.project=?",
        project,
      ),
    });
    if (Buffer.byteLength(data) > 150_000_000) fail(413, "项目快照过大");
    this.run(
      "INSERT INTO snapshots(id,project,label,author,created,data,manual) VALUES(?,?,?,?,?,?,?)",
      id,
      project,
      label,
      user,
      Date.now(),
      data,
      manual ? 1 : 0,
    );
    if (!manual)
      this.run(
        `DELETE FROM snapshots WHERE project=? AND manual=0
          AND id NOT IN (SELECT base FROM jobs WHERE project=? AND status IN ('queued','running'))
          AND id NOT IN (SELECT id FROM snapshots WHERE project=? AND manual=0 ORDER BY created DESC, rowid DESC LIMIT ?)`,
        project,
        project,
        project,
        AUTOMATIC_SNAPSHOTS,
      );
    return id;
  }
  close() {
    this.db.close();
  }
}
