import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import {
  importBibliography,
  mergeText,
  normalizeDoi,
  type ReviewHunk,
  renameBibKey,
  renameCitationKey,
  reviewedText,
  reviewHunks,
} from "@lmms-lab/writing";
import { zipSync } from "fflate";
import * as Y from "yjs";
import {
  allowedOrigin,
  bootstrap,
  cookie,
  passwordHash,
  session,
  userFor,
  verifyPassword,
} from "./auth";
import { Collaboration } from "./collaboration";
import { projectJobs, runnerRequest } from "./jobs";
import {
  checked,
  decodeText,
  digest,
  type FileRow,
  fail,
  HttpError,
  isTextPath,
  type Role,
  Store,
  safePath,
  textDoc,
  type User,
  uid,
} from "./store";

type Body = Record<string, unknown>;
const str = (body: Body, key: string, max = 10000) =>
  typeof body[key] === "string" && body[key].length <= max
    ? (body[key] as string)
    : fail(400, `无效字段 ${key}`);
const number = (body: Body, key: string) =>
  typeof body[key] === "number" && Number.isSafeInteger(body[key])
    ? (body[key] as number)
    : fail(400, `无效字段 ${key}`);
async function jsonBody(req: IncomingMessage): Promise<Body> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > 16_000_000) fail(413, "请求超过 16 MB");
    chunks.push(b);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail(400, "无效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "请求必须为 JSON 对象");
  return value as Body;
}
const uniqueViolation = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint failed/.test(error.message);
function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
function roleInput(value: string): Role {
  if (!["owner", "editor", "commenter", "viewer"].includes(value)) fail(400, "无效角色");
  return value as Role;
}
const publicUser = (u: User) => ({ id: u.id, name: u.username, admin: !!u.admin });
type Proposal = {
  id: string;
  project: string;
  file: string;
  author: string;
  base: string;
  proposed: string;
  hunks: string;
  revision: number;
  created: number;
};
type SnapshotData = {
  files: Array<Omit<FileRow, "state"> & { state: string }>;
  comments: Body[];
  replies: Body[];
};
export type Options = {
  directory: string;
  adminUser?: string;
  adminPassword?: string;
  host?: string;
  port?: number;
  origin?: string;
  staticDirectory?: string;
};
export async function createWriterServer(options: Options) {
  const store = new Store(options.directory);
  await bootstrap(store, options.adminUser ?? "", options.adminPassword ?? "");
  let origin = options.origin ?? `http://127.0.0.1:${options.port ?? 8787}`;
  const collab = new Collaboration(store, () => origin);
  const attempts = new Map<string, { at: number; count: number }>();
  // Unknown usernames still pay the scrypt cost, so login timing does not reveal accounts.
  const decoy = await passwordHash(randomBytes(16).toString("hex"));
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url ?? "/", origin),
        method = req.method ?? "GET";
      const path = url.pathname;
      if (!["GET", "HEAD"].includes(method) && !allowedOrigin(req.headers.origin, origin))
        fail(403, "请求来源不匹配");
      if (path === "/api/health") return json(res, { ok: true });
      if (["/api/login", "/api/join"].includes(path) && method === "POST") {
        const ip = req.socket.remoteAddress ?? "unknown",
          old = attempts.get(ip),
          attempt = old && Date.now() - old.at < 60000 ? old : { at: Date.now(), count: 0 };
        attempts.set(ip, attempt);
        if (++attempt.count > 12) fail(429, "登录尝试过多，请稍后重试");
        if (attempts.size > 1000)
          for (const [key, a] of attempts) if (Date.now() - a.at > 60000) attempts.delete(key);
      }
      if (path === "/api/login" && method === "POST") {
        const body = await jsonBody(req),
          username = str(body, "username", 80),
          password = str(body, "password", 200);
        const user = store.get<User>("SELECT * FROM users WHERE username=?", username);
        const valid = await verifyPassword(password, user?.password ?? decoy);
        if (!user || !valid) fail(401, "用户名或密码错误");
        session(store, user, res, origin.startsWith("https:"));
        return json(res, publicUser(user));
      }
      if (path === "/api/join" && method === "POST") {
        const body = await jsonBody(req),
          token = str(body, "token", 100),
          username = str(body, "username", 80),
          password = str(body, "password", 200);
        if (!/^[\p{L}\p{N}_ .-]{2,80}$/u.test(username)) fail(400, "用户名格式无效");
        const invitation = store.get<{
          project: string;
          role: Role;
          expires: number;
          used: number;
        }>("SELECT * FROM invites WHERE token=?", digest(token));
        if (!invitation || invitation.used || invitation.expires < Date.now())
          fail(410, "邀请已失效");
        let user = store.get<User>("SELECT * FROM users WHERE username=?", username);
        if (user && !(await verifyPassword(password, user.password)))
          fail(401, "该用户名已存在，请使用原密码");
        const created = user
          ? null
          : { id: uid(), username, password: await passwordHash(password), admin: 0 };
        store.transaction(() => {
          const claimed = store.run(
            "UPDATE invites SET used=1 WHERE token=? AND used=0 AND expires>?",
            digest(token),
            Date.now(),
          );
          if (!claimed.changes) fail(410, "邀请已使用");
          if (created)
            store.run(
              "INSERT INTO users VALUES(?,?,?,0)",
              created.id,
              created.username,
              created.password,
            );
          user ??= created as User;
          if (
            !store.get(
              "SELECT role FROM members WHERE project=? AND user=?",
              invitation.project,
              user.id,
            )
          )
            store.run(
              "INSERT INTO members VALUES(?,?,?)",
              invitation.project,
              user.id,
              invitation.role,
            );
          store.audit(invitation.project, user.id, "member.join", {});
        });
        if (!user) fail(500, "无法创建账号");
        session(store, user, res, origin.startsWith("https:"));
        return json(res, publicUser(user));
      }
      if (!path.startsWith("/api/")) {
        const root = resolve(options.staticDirectory ?? join(import.meta.dirname, "../dist"));
        let requested = "index.html";
        if (path !== "/" && extname(path))
          try {
            requested = decodeURIComponent(path).replace(/^\//, "");
          } catch {
            fail(400, "无效路径");
          }
        const file = resolve(root, requested);
        if (!file.startsWith(`${root}/`)) fail(403, "无效路径");
        const content = await readFile(file).catch(() =>
          fail(404, "资源不存在，请先运行 pnpm build"),
        );
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        res.writeHead(200, {
          "Content-Type": `${types[extname(file)] ?? "application/octet-stream"}; charset=utf-8`,
        });
        res.end(method === "HEAD" ? undefined : content);
        return;
      }
      if (path.startsWith("/api/runner/") && method === "POST")
        return json(res, runnerRequest(store, collab, req, path, await jsonBody(req)));
      const user = userFor(store, req);
      if (path === "/api/me") return json(res, publicUser(user));
      if (path === "/api/logout" && method === "POST") {
        store.run("DELETE FROM sessions WHERE token=?", digest(cookie(req)));
        res.setHeader(
          "Set-Cookie",
          "writer_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        for (const p of collab.peers) if (p.user.id === user.id) p.socket.close(1008);
        return json(res, { ok: true });
      }
      if (path === "/api/projects") {
        if (method === "GET")
          return json(
            res,
            store.all(
              "SELECT p.*,m.role FROM projects p JOIN members m ON p.id=m.project WHERE m.user=? ORDER BY p.created DESC",
              user.id,
            ),
          );
        if (method === "POST") {
          const body = await jsonBody(req),
            name = str(body, "name", 120).trim();
          if (!name) fail(400, "请填写项目名");
          const id = uid();
          store.transaction(() => {
            store.run("INSERT INTO projects VALUES(?,?,?)", id, name, Date.now());
            store.run("INSERT INTO members VALUES(?,?,?)", id, user.id, "owner");
          });
          return json(res, { id, name, role: "owner" }, 201);
        }
      }
      const route = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (!route?.[1]) fail(404, "接口不存在");
      const project = route[1],
        rest = route[2] ?? "",
        role = store.require(project, user.id);
      const edit = () => store.require(project, user.id, "edit"),
        owner = () => store.require(project, user.id, "owner");
      if (!rest && method === "GET")
        return json(res, {
          ...store.get<Body>("SELECT * FROM projects WHERE id=?", project),
          role,
        });
      if (/^(jobs|runners)(\/|$)/.test(rest))
        return json(
          res,
          projectJobs(
            store,
            collab,
            project,
            user,
            role,
            rest,
            method,
            method === "GET" ? {} : await jsonBody(req),
          ),
        );
      if (rest === "members") {
        if (method === "GET")
          return json(
            res,
            store.all(
              "SELECT u.id,u.username,m.role FROM members m JOIN users u ON u.id=m.user WHERE m.project=?",
              project,
            ),
          );
      }
      if (rest.startsWith("members/") && method === "DELETE") {
        owner();
        const target = rest.slice(8);
        if (target === user.id) fail(400, "不能撤销自己的所有者权限");
        store.run("DELETE FROM members WHERE project=? AND user=?", project, target);
        collab.revoke(project, target);
        store.audit(project, user.id, "member.revoke", { user: target });
        collab.changed(project);
        return json(res, { ok: true });
      }
      if (rest === "invite" && method === "POST") {
        owner();
        const body = await jsonBody(req),
          role = roleInput(str(body, "role"));
        if (role === "owner") fail(400, "邀请不能授予所有者角色");
        const token = randomBytes(32).toString("hex");
        store.run(
          "INSERT INTO invites VALUES(?,?,?,?,0)",
          digest(token),
          project,
          role,
          Date.now() + 7 * 86400000,
        );
        return json(res, { token, url: `${origin}/?invite=${token}`, expiresInDays: 7 });
      }
      if (rest === "files") {
        if (method === "GET")
          return json(
            res,
            store.all(
              "SELECT id,path,binary,revision FROM files WHERE project=? AND deleted=0 ORDER BY path",
              project,
            ),
          );
        if (method === "POST") {
          edit();
          const body = await jsonBody(req),
            path = safePath(str(body, "path", 240));
          const binary = !isTextPath(path);
          const value = str(body, binary ? "base64" : "content", binary ? 14_000_000 : 2_000_000);
          let bytes: Uint8Array;
          if (binary) {
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(400, "无效文件编码");
            bytes = Buffer.from(value, "base64");
          } else {
            if (Buffer.byteLength(value) > 2_000_000) fail(413, "文本文件超过 2 MB");
            const d = textDoc(value);
            bytes = Y.encodeStateAsUpdate(d);
            d.destroy();
          }
          if (bytes.length > 10_000_000) fail(413, "单文件超过 10 MB");
          const limits = store.get<{ count: number; bytes: number }>(
            "SELECT count(*) as count,coalesce(sum(length(state)),0) as bytes FROM files WHERE project=?",
            project,
          );
          if ((limits?.count ?? 0) >= 2000 || (limits?.bytes ?? 0) + bytes.length > 100_000_000)
            fail(413, "项目超过 2000 个文件或 100 MB");
          const id = uid();
          try {
            store.transaction(() => {
              store.releasePath(project, path);
              store.run(
                "INSERT INTO files(id,project,path,state,binary) VALUES(?,?,?,?,?)",
                id,
                project,
                path,
                bytes,
                binary ? 1 : 0,
              );
            });
          } catch (error) {
            if (uniqueViolation(error)) fail(409, "同名文件已存在，请在编辑器中更新");
            throw error;
          }
          store.audit(project, user.id, "file.create", { id, path });
          collab.changed(project);
          return json(res, { id, path, binary, revision: 1 }, 201);
        }
      }
      const fileRoute = /^files\/([^/]+)(?:\/(.*))?$/.exec(rest);
      if (fileRoute?.[1]) {
        const file = store.file(project, fileRoute[1]);
        if (method === "GET" && !fileRoute[2])
          return json(res, {
            id: file.id,
            path: file.path,
            binary: !!file.binary,
            revision: file.revision,
            ...(file.binary
              ? { base64: Buffer.from(file.state).toString("base64") }
              : { content: decodeText(file.state) }),
          });
        if (method === "PUT") {
          edit();
          if (file.binary) fail(400, "二进制文件请上传为新版本文件名");
          const body = await jsonBody(req);
          collab.replace(
            project,
            file.id,
            str(body, "expected", 2_000_000),
            str(body, "content", 2_000_000),
            user.id,
          );
          return json(res, { ok: true });
        }
        if (method === "PATCH") {
          edit();
          const body = await jsonBody(req);
          const path = safePath(str(body, "path", 240));
          if (isTextPath(path) === !!file.binary)
            fail(400, "重命名不能改变文本／二进制文件类型，请上传为新文件");
          try {
            store.transaction(() => {
              store.releasePath(project, path);
              store.run("UPDATE files SET path=? WHERE id=?", path, file.id);
              store.audit(project, user.id, "file.rename", {
                file: file.id,
                from: file.path,
                path,
              });
            });
          } catch (error) {
            if (uniqueViolation(error)) fail(409, "目标路径已有文件");
            throw error;
          }
          collab.changed(project);
          return json(res, { ok: true });
        }
        if (method === "DELETE") {
          edit();
          store.snapshot(project, user.id, "删除文件前");
          store.transaction(() => {
            store.run("UPDATE files SET deleted=1 WHERE id=?", file.id);
            store.audit(project, user.id, "file.delete", { file: file.id, path: file.path });
          });
          for (const p of collab.peers) if (p.file === file.id) p.socket.close(1008, "文件已删除");
          collab.changed(project);
          return json(res, { ok: true });
        }
      }
      if (rest === "sources" && method === "GET") return json(res, store.textFiles(project));
      if (rest === "doi" && method === "POST") {
        edit();
        const body = await jsonBody(req),
          doi = checked(() => normalizeDoi(str(body, "doi", 300)));
        const response = await fetch(
          `https://api.crossref.org/works/${encodeURIComponent(doi)}/transform/application/x-bibtex`,
          {
            signal: AbortSignal.timeout(20000),
            redirect: "error",
            headers: { "User-Agent": "Writer bibliography lookup" },
          },
        );
        if (!response.ok) fail(502, "Crossref 未找到这个 DOI");
        const data = await response.text();
        if (data.length > 100000) fail(502, "元数据过大");
        return json(res, { bibtex: data });
      }
      if (rest === "bibliography/import" && method === "POST") {
        edit();
        const body = await jsonBody(req),
          file = store.file(project, str(body, "file"));
        if (file.binary || !file.path.endsWith(".bib")) fail(400, "请选择 BibTeX 文件");
        const current = decodeText(file.state);
        if (current !== str(body, "expected", 2_000_000)) fail(409, "文献库已有新的修改");
        const result = checked(() => importBibliography(current, str(body, "bibtex", 2_000_000)));
        if (!result.added)
          return json(res, { added: 0, skipped: result.skipped, renamed: result.renamed });
        store.snapshot(project, user.id, "导入文献前");
        collab.replace(project, file.id, current, result.content, user.id);
        return json(res, { added: result.added, skipped: result.skipped, renamed: result.renamed });
      }
      if (rest === "bibliography/rename" && method === "POST") {
        edit();
        const body = await jsonBody(req),
          from = str(body, "from", 150),
          to = str(body, "to", 150);
        const files = store.textFiles(project);
        const plans = checked(() =>
          files
            .map((f) => ({
              ...f,
              next: f.path.endsWith(".bib")
                ? renameBibKey(f.content, from, to)
                : f.path.endsWith(".tex")
                  ? renameCitationKey(f.content, from, to)
                  : f.content,
            }))
            .filter((f) => f.content !== f.next),
        );
        if (!plans.length) return json(res, { files: 0 });
        store.snapshot(project, user.id, "重命名文献键前");
        collab.replaceMany(
          project,
          plans.map((p) => ({ file: p.id, expected: p.content, content: p.next })),
          user.id,
        );
        return json(res, { files: plans.length });
      }
      if (rest === "comments") {
        if (method === "GET")
          return json(
            res,
            store
              .all<Body>(
                "SELECT c.*,u.username AS authorName FROM comments c JOIN users u ON c.author=u.id WHERE c.project=? ORDER BY c.created DESC",
                project,
              )
              .map((c) => ({
                ...c,
                replies: store.all(
                  "SELECT r.*,u.username AS authorName FROM replies r JOIN users u ON r.author=u.id WHERE r.comment=? ORDER BY r.created",
                  c.id as string,
                ),
              })),
          );
        if (method === "POST") {
          store.require(project, user.id, "comment");
          const b = await jsonBody(req),
            file = store.file(project, str(b, "file")),
            start = str(b, "start", 10000),
            end = str(b, "end", 10000);
          if (file.binary) fail(400, "请选择源码段落批注");
          const d = new Y.Doc();
          Y.applyUpdate(d, file.state);
          const selectedText = d.getText("content");
          try {
            const a = Y.createAbsolutePositionFromRelativePosition(
                Y.decodeRelativePosition(Buffer.from(start, "base64")),
                d,
              ),
              z = Y.createAbsolutePositionFromRelativePosition(
                Y.decodeRelativePosition(Buffer.from(end, "base64")),
                d,
              );
            if (!a || !z || a.type !== selectedText || z.type !== a.type || a.index >= z.index)
              fail(409, "选区已失效，请重新选择");
            if (selectedText.toString().slice(a.index, z.index) !== str(b, "quote", 20000))
              fail(409, "选文已被修改，请核对后重新批注");
          } finally {
            d.destroy();
          }
          const id = uid(),
            body = str(b, "body").trim();
          if (!body) fail(400, "批注不能为空");
          store.transaction(() => {
            store.run(
              "INSERT INTO comments VALUES(?,?,?,?,?,?,?,?,0,?,?)",
              id,
              project,
              file.id,
              user.id,
              str(b, "quote", 20000),
              start,
              end,
              body,
              Date.now(),
              Date.now(),
            );
            store.audit(project, user.id, "comment.create", { id, file: file.id });
          });
          collab.changed(project);
          return json(res, { id }, 201);
        }
      }
      const commentRoute = /^comments\/([^/]+)(?:\/(reply))?$/.exec(rest);
      if (commentRoute?.[1]) {
        store.require(project, user.id, "comment");
        const comment =
          store.get<Body>(
            "SELECT * FROM comments WHERE project=? AND id=?",
            project,
            commentRoute[1],
          ) ?? fail(404, "批注不存在");
        const body = await jsonBody(req);
        if (method === "POST" && commentRoute[2] === "reply") {
          const text = str(body, "body").trim();
          if (!text) fail(400, "回复不能为空");
          store.transaction(() => {
            store.run(
              "INSERT INTO replies VALUES(?,?,?,?,?)",
              uid(),
              comment.id as string,
              user.id,
              text,
              Date.now(),
            );
            store.audit(project, user.id, "comment.reply", { id: comment.id });
          });
        } else if (method === "PATCH") {
          if (comment.author !== user.id && !["owner", "editor"].includes(role))
            fail(403, "只有作者或编辑者可以更改批注状态");
          const resolved = body.resolved === true ? 1 : 0;
          store.transaction(() => {
            store.run(
              "UPDATE comments SET resolved=?,updated=? WHERE id=?",
              resolved,
              Date.now(),
              comment.id as string,
            );
            store.audit(project, user.id, resolved ? "comment.resolve" : "comment.reopen", {
              id: comment.id,
            });
          });
        } else fail(405, "不支持的操作");
        collab.changed(project);
        return json(res, { ok: true });
      }
      if (rest === "snapshots") {
        if (method === "GET")
          return json(
            res,
            store.all(
              "SELECT id,label,author,created,manual FROM snapshots WHERE project=? ORDER BY created DESC LIMIT 100",
              project,
            ),
          );
        if (method === "POST") {
          edit();
          const body = await jsonBody(req);
          const label =
            typeof body.label === "string" && body.label.trim()
              ? str(body, "label", 200).trim()
              : "手动版本";
          const id = store.snapshot(project, user.id, label, true);
          collab.changed(project);
          return json(res, { id }, 201);
        }
      }
      const restore = /^snapshots\/([^/]+)\/restore$/.exec(rest);
      if (restore?.[1] && method === "POST") {
        owner();
        const body = await jsonBody(req),
          fileId = str(body, "file"),
          expected = str(body, "expected", 2_000_000);
        const saved =
          store.get<{ data: string }>(
            "SELECT data FROM snapshots WHERE id=? AND project=?",
            restore[1],
            project,
          ) ?? fail(404, "版本不存在");
        const snap = JSON.parse(saved.data) as SnapshotData;
        const old =
          snap.files.find((f) => f.id === fileId && !f.binary && !f.deleted) ??
          fail(404, "该版本不含此文档");
        const current = store.file(project, fileId);
        if (current.binary) fail(400, "只支持恢复文本");
        store.snapshot(project, user.id, "恢复文档前");
        collab.replace(
          project,
          fileId,
          expected,
          decodeText(Buffer.from(old.state, "base64")),
          user.id,
        );
        return json(res, { ok: true });
      }
      if (rest === "export" && method === "GET") {
        const files = store.all<FileRow>(
          "SELECT * FROM files WHERE project=? AND deleted=0",
          project,
        );
        const entries: Record<string, Uint8Array> = {};
        for (const f of files)
          entries[safePath(f.path)] = f.binary
            ? new Uint8Array(f.state)
            : Buffer.from(decodeText(f.state));
        entries["writer-collaboration-notes.json"] = Buffer.from(
          JSON.stringify(
            {
              comments: store.all("SELECT * FROM comments WHERE project=?", project),
              audit: store.all("SELECT * FROM audit WHERE project=? ORDER BY created", project),
            },
            null,
            2,
          ),
        );
        const zipped = zipSync(entries);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="writer-project.zip"',
        });
        res.end(zipped);
        return;
      }
      if (rest === "proposals") {
        if (method === "GET")
          return json(
            res,
            store
              .all<Proposal>(
                "SELECT * FROM proposals WHERE project=? ORDER BY created DESC LIMIT 100",
                project,
              )
              .map((p) => ({ ...p, hunks: JSON.parse(p.hunks) })),
          );
        if (method === "POST") {
          edit();
          const body = await jsonBody(req),
            file = store.file(project, str(body, "file"));
          if (file.binary) fail(400, "暂不支持二进制补丁");
          const base = str(body, "base", 2_000_000),
            proposed = str(body, "proposed", 2_000_000),
            id = uid();
          const hunks = checked(() => reviewHunks(base, proposed));
          store.run(
            "INSERT INTO proposals VALUES(?,?,?,?,?,?,?,1,?)",
            id,
            project,
            file.id,
            user.id,
            base,
            proposed,
            JSON.stringify(hunks),
            Date.now(),
          );
          store.audit(project, user.id, "proposal.create", { id, file: file.id });
          collab.changed(project);
          return json(res, { id }, 201);
        }
      }
      const decision = /^proposals\/([^/]+)\/decide$/.exec(rest);
      if (decision?.[1] && method === "POST") {
        edit();
        const body = await jsonBody(req),
          p =
            store.get<Proposal>(
              "SELECT * FROM proposals WHERE project=? AND id=?",
              project,
              decision[1],
            ) ?? fail(404, "建议不存在");
        if (p.revision !== number(body, "revision")) fail(409, "建议已被其他人更新");
        const hunks = JSON.parse(p.hunks) as ReviewHunk[],
          part = hunks[number(body, "part")];
        if (!part) fail(400, "修改项不存在");
        const status = str(body, "status");
        if (!["pending", "accepted", "rejected"].includes(status)) fail(400, "无效决定");
        const rendered = () =>
          reviewedText(
            p.proposed,
            hunks.map((h) => ({ ...h, status: h.status === "accepted" ? "accepted" : "rejected" })),
          );
        const before = rendered();
        part.status = status as ReviewHunk["status"];
        const after = rendered(),
          file = store.file(project, p.file),
          current = decodeText(file.state),
          merged = mergeText(before, current, after);
        if (merged.content === null)
          fail(409, "这处内容已有重叠修改；建议保留，请核对最新正文后重新提交");
        store.snapshot(project, user.id, "审阅决定前");
        collab.replaceMany(
          project,
          [{ file: p.file, expected: current, content: merged.content }],
          user.id,
          () => {
            store.run(
              "UPDATE proposals SET hunks=?,revision=revision+1 WHERE id=?",
              JSON.stringify(hunks),
              p.id,
            );
            store.audit(project, user.id, "proposal.decide", { id: p.id, part: body.part, status });
          },
        );
        collab.changed(project);
        return json(res, { ok: true });
      }
      if (rest === "audit" && method === "GET")
        return json(
          res,
          store.all(
            "SELECT a.*,u.username AS name FROM audit a LEFT JOIN users u ON a.actor=u.id WHERE a.project=? ORDER BY a.created DESC LIMIT 200",
            project,
          ),
        );
      fail(404, "接口不存在");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      json(
        res,
        {
          error:
            status === 500
              ? "服务操作失败，数据仍保留；请检查服务日志"
              : error instanceof Error
                ? error.message
                : "操作失败",
        },
        status,
      );
      if (status === 500)
        console.error("Writer request failed:", error instanceof Error ? error.message : "unknown");
    }
  });
  server.on("upgrade", (req, socket, head) => collab.upgrade(req, socket, head));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!options.origin && address && typeof address !== "string")
    origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    store,
    collab,
    origin,
    close: async () => {
      collab.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      store.close();
    },
  };
}
