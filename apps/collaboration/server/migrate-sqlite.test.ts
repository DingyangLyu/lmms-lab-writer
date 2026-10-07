import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createWriterServer } from "./app";
import { passwordHash } from "./auth";
import { connect } from "./db";
import { importSqlite } from "./migrate-sqlite";
import { textDoc } from "./util";

/** The schema written by Writer collaboration before the PostgreSQL migration. */
const LEGACY = `
CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions(token TEXT PRIMARY KEY,user TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE members(project TEXT NOT NULL REFERENCES projects(id),user TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(project,user));
CREATE TABLE invites(token TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),role TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE files(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),path TEXT NOT NULL,state BLOB NOT NULL,binary INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,UNIQUE(project,path));
CREATE TABLE comments(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),file TEXT NOT NULL REFERENCES files(id),author TEXT NOT NULL REFERENCES users(id),quote TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,body TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE replies(id TEXT PRIMARY KEY,comment TEXT NOT NULL REFERENCES comments(id),author TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE snapshots(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),label TEXT NOT NULL,author TEXT NOT NULL REFERENCES users(id),created INTEGER NOT NULL,data TEXT NOT NULL,manual INTEGER NOT NULL DEFAULT 1);
CREATE TABLE audit(id TEXT PRIMARY KEY,project TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE proposals(id TEXT PRIMARY KEY,project TEXT NOT NULL,file TEXT NOT NULL,author TEXT NOT NULL,base TEXT NOT NULL,proposed TEXT NOT NULL,hunks TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY,project TEXT NOT NULL,author TEXT NOT NULL,prompt TEXT NOT NULL,harness TEXT NOT NULL,status TEXT NOT NULL,runner TEXT,lease INTEGER,result TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,base TEXT NOT NULL);
CREATE TABLE runners(id TEXT PRIMARY KEY,project TEXT NOT NULL,token TEXT NOT NULL UNIQUE,name TEXT NOT NULL,capabilities TEXT NOT NULL DEFAULT '[]');`;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("SQLite import", () => {
  it("moves accounts, documents and discussions into PostgreSQL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writer-import-test-"));
    dirs.push(dir);
    const legacy = new DatabaseSync(join(dir, "writer.sqlite"));
    legacy.exec(LEGACY);
    const doc = textDoc("迁移前的正文\n");
    const state = Y.encodeStateAsUpdate(doc);
    const text = doc.getText("content");
    const start = Buffer.from(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 0)),
    ).toString("base64");
    const end = Buffer.from(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 3)),
    ).toString("base64");
    doc.destroy();
    const insert = (q: string, ...values: Array<string | number | Uint8Array | null>) =>
      legacy.prepare(q).run(...values);
    insert(
      "INSERT INTO users VALUES(?,?,?,1)",
      "u1",
      "lab",
      await passwordHash("legacy-password-1"),
    );
    insert("INSERT INTO projects VALUES(?,?,?)", "p1", "旧项目", 1);
    insert("INSERT INTO members VALUES(?,?,?)", "p1", "u1", "owner");
    insert("INSERT INTO files VALUES(?,?,?,?,0,0,3)", "f1", "p1", "main.tex", state);
    insert(
      "INSERT INTO comments VALUES(?,?,?,?,?,?,?,?,1,?,?)",
      "c1",
      "p1",
      "f1",
      "u1",
      "迁移前",
      start,
      end,
      "请核对",
      2,
      3,
    );
    insert("INSERT INTO replies VALUES(?,?,?,?,?)", "r1", "c1", "u1", "已核对", 4);
    insert(
      "INSERT INTO jobs VALUES(?,?,?,?,?,?,NULL,NULL,'',?,?)",
      "j1",
      "p1",
      "u1",
      "x",
      "codex",
      "queued",
      5,
      "s1",
    );
    legacy.close();

    const url = `pglite:${join(dir, "pg")}`;
    const db = await connect(url);
    const counts = await importSqlite(join(dir, "writer.sqlite"), db);
    expect(counts).toMatchObject({ users: 1, files: 1, comments: 1, replies: 1, jobs: 1 });
    await expect(importSqlite(join(dir, "writer.sqlite"), db)).rejects.toThrow("拒绝重复导入");
    await db.close();

    const app = await createWriterServer({ databaseUrl: url, port: 0 });
    try {
      const call = async (path: string, body?: unknown, cookie = "") => {
        const r = await fetch(`${app.origin}/api${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { Origin: app.origin, Cookie: cookie },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { data: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] || "" };
      };
      const login = await call("/login", { username: "lab", password: "legacy-password-1" });
      expect(login.data.admin).toBe(true);
      const files = (await call("/projects/p1/files", undefined, login.cookie)).data;
      expect(files).toEqual([{ id: "f1", path: "main.tex", binary: false, revision: 3 }]);
      expect((await call("/projects/p1/files/f1", undefined, login.cookie)).data.content).toBe(
        "迁移前的正文\n",
      );
      const comments = (await call("/projects/p1/comments", undefined, login.cookie)).data;
      expect(comments[0]).toMatchObject({ quote: "迁移前", start, end, resolved: true });
      expect(comments[0].replies[0].body).toBe("已核对");
      const jobs = (await call("/projects/p1/jobs", undefined, login.cookie)).data;
      expect(jobs[0].status).toBe("failed");
    } finally {
      await app.close();
    }
  });
});
