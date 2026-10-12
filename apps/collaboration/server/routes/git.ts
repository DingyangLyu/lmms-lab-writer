/** Git sync: members' access per host, and a project's repository branch (see ../git.ts). */
import type { GitCredentialInfo, GitPullResult, GitStatus } from "../../shared/api";
import { sql } from "../db";
import { branchName, type GitCredential, type GitKind, type GitRemote, parseRemote } from "../git";
import { type Authed, type Body, type InProject, route, str } from "../http";
import { requestLocale, say } from "../messages";
import { fail } from "../util";

type RemoteRow = {
  url: string;
  branch: string;
  base: string | null;
  untracked: string;
  synced: number | null;
  syncedBy: string | null;
  action: "pull" | "push" | null;
};
const optional = (body: Body, key: string, max: number) => {
  const value = typeof body[key] === "string" ? (body[key] as string).trim() : "";
  if (value.length > max) fail(400, "无效字段 {key}", { key });
  return value || null;
};
const kindOf = (value: string): GitKind =>
  value === "token" || value === "ssh" ? value : fail(400, "无效的凭据类型");
const hostOf = (value: string) => {
  const host = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,200}$/.test(host)) fail(400, "无效的主机名");
  return host;
};

async function remoteOf(ctx: InProject) {
  return ctx.store.db.row<RemoteRow>(
    sql`SELECT r.url, r.branch, r.base, r.untracked, r.synced, u.username AS "syncedBy", r.action
        FROM git_remotes r LEFT JOIN users u ON u.id=r.synced_by WHERE r.project=${ctx.project}`,
  );
}
const linked = async (ctx: InProject) =>
  (await remoteOf(ctx)) ?? fail(400, "这个项目还没有关联 Git 仓库");
const asRemote = (row: RemoteRow): GitRemote => ({
  url: row.url,
  branch: row.branch,
  base: row.base,
  untracked: JSON.parse(row.untracked) as string[],
});
/** The member's access for the repository's host, or null where none is needed. */
async function credentialFor(ctx: Authed, url: string): Promise<GitCredential | null> {
  const { host, kind } = parseRemote(url, ctx.git.allowsFile);
  if (!kind) return null;
  return (
    (await ctx.store.db.row<GitCredential>(
      sql`SELECT kind, username, secret, author_name AS "authorName", author_email AS "authorEmail"
          FROM git_credentials WHERE user_id=${ctx.user.id} AND host=${host} AND kind=${kind}`,
    )) ??
    fail(
      400,
      kind === "token" ? "请先保存你在 {host} 的访问令牌" : "请先保存你在 {host} 的 SSH 私钥",
      { host },
    )
  );
}
async function synced(ctx: InProject, base: string | null, untracked: string[], action: string) {
  await ctx.store.db.run(
    sql`UPDATE git_remotes SET base=${base}, untracked=${JSON.stringify(untracked)},
          synced=${Date.now()}, synced_by=${ctx.user.id}, action=${action}
        WHERE project=${ctx.project}`,
  );
}

export const gitAccountRoutes = [
  route<Authed>("GET", /^\/api\/me\/git$/, (ctx) =>
    ctx.store.db.rows<GitCredentialInfo>(
      sql`SELECT host, kind, username, author_name AS "authorName", author_email AS "authorEmail",
                 created FROM git_credentials WHERE user_id=${ctx.user.id} ORDER BY host, kind`,
    ),
  ),
  route<Authed>("POST", /^\/api\/me\/git$/, async (ctx) => {
    const body = await ctx.body(),
      host = hostOf(str(body, "host", 200)),
      kind = kindOf(str(body, "kind", 10)),
      secret = str(body, "secret", 20_000).trim();
    if (kind === "token" && !/^[\x21-\x7e]{8,500}$/.test(secret)) fail(400, "无效的访问令牌");
    if (
      kind === "ssh" &&
      !/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/.test(secret)
    )
      fail(400, "请粘贴完整的 SSH 私钥（-----BEGIN … PRIVATE KEY----- 开头）");
    const email = optional(body, "authorEmail", 200);
    if (email && !/^[^\s<>@]+@[^\s<>@]+$/.test(email)) fail(400, "无效的邮箱");
    await ctx.store.db.run(
      sql`INSERT INTO git_credentials(user_id, host, kind, username, secret, author_name, author_email, created)
          VALUES(${ctx.user.id}, ${host}, ${kind}, ${optional(body, "username", 100)}, ${secret},
            ${optional(body, "authorName", 100)}, ${email}, ${Date.now()})
          ON CONFLICT (user_id, host, kind) DO UPDATE SET username=excluded.username,
            secret=excluded.secret, author_name=excluded.author_name,
            author_email=excluded.author_email, created=excluded.created`,
    );
    return { ok: true };
  }),
  route<Authed>("POST", /^\/api\/me\/git\/remove$/, async (ctx) => {
    const body = await ctx.body();
    await ctx.store.db.run(
      sql`DELETE FROM git_credentials WHERE user_id=${ctx.user.id}
          AND host=${hostOf(str(body, "host", 200))} AND kind=${kindOf(str(body, "kind", 10))}`,
    );
    return { ok: true };
  }),
];

export const gitRoutes = [
  route<InProject>("GET", /^git$/, async (ctx): Promise<GitStatus> => {
    const row = await remoteOf(ctx);
    if (!row) return { remote: null, changed: null, hasCredential: false };
    const { host, kind } = parseRemote(row.url, ctx.git.allowsFile);
    const remote = asRemote(row);
    const has =
      !kind ||
      !!(await ctx.store.db.row(
        sql`SELECT 1 FROM git_credentials WHERE user_id=${ctx.user.id} AND host=${host} AND kind=${kind}`,
      ));
    return {
      remote: {
        url: row.url,
        branch: row.branch,
        host,
        kind,
        base: row.base,
        synced: row.synced === null ? null : Number(row.synced),
        syncedBy: row.syncedBy,
        action: row.action,
        untracked: remote.untracked.length,
      },
      changed: await ctx.git.exclusive(ctx.project, () =>
        ctx.git.changedFiles(ctx.project, remote),
      ),
      hasCredential: has,
    };
  }),
  // Links (or re-links) the project to a branch, after checking the member's access to it.
  route<InProject>("POST", /^git\/link$/, async (ctx) => {
    await ctx.need("edit");
    const body = await ctx.body(),
      url = str(body, "url", 500).trim(),
      branch = branchName(str(body, "branch", 100));
    const credential = await credentialFor(ctx, url);
    const head = await ctx.git.exclusive(ctx.project, () =>
      ctx.git.remoteHead(ctx.project, { url, branch }, credential),
    );
    const old = await remoteOf(ctx);
    const same = old?.url === url && old.branch === branch;
    await ctx.store.db.run(
      sql`INSERT INTO git_remotes(project, url, branch, base, untracked, created_by)
          VALUES(${ctx.project}, ${url}, ${branch}, NULL, '[]', ${ctx.user.id})
          ON CONFLICT (project) DO UPDATE SET url=excluded.url, branch=excluded.branch,
            base=${same ? old.base : null}, untracked=${same ? old.untracked : "[]"},
            created_by=excluded.created_by`,
    );
    await ctx.store.audit(ctx.project, ctx.user.id, "git.link", { url, branch });
    return { exists: !!head };
  }),
  route<InProject>("POST", /^git\/pull$/, async (ctx): Promise<GitPullResult> => {
    await ctx.need("edit");
    const row = await linked(ctx);
    const credential = await credentialFor(ctx, row.url);
    return ctx.git.exclusive(ctx.project, async () => {
      const remote = asRemote((await remoteOf(ctx)) ?? row);
      const pulled = await ctx.git.pull(ctx.project, ctx.user.id, remote, credential, () =>
        ctx.store.snapshot(ctx.project, ctx.user.id, "Git 拉取前").then(() => {}),
      );
      if (pulled.base !== remote.base || pulled.results.length)
        await synced(ctx, pulled.base, pulled.untracked, "pull");
      await ctx.store.audit(ctx.project, ctx.user.id, "git.pull", { commit: pulled.base });
      return {
        commit: pulled.base,
        applied: pulled.results.filter((r) => r.status === "applied").length,
        proposals: pulled.results.filter((r) => r.status === "proposal").length,
        skipped: pulled.results
          .filter((r) => r.status === "skipped")
          .map((r) => ({
            path: r.path,
            reason: say(requestLocale(ctx.req.headers), r.reason ?? ""),
          })),
      };
    });
  }),
  route<InProject>("POST", /^git\/push$/, async (ctx) => {
    await ctx.need("edit");
    const row = await linked(ctx);
    const credential = await credentialFor(ctx, row.url);
    const message = optional(await ctx.body(), "message", 2000) ?? "Update from Writer";
    const author = {
      name: credential?.authorName || ctx.user.username,
      email: credential?.authorEmail || `${ctx.user.username}@users.noreply.writer`,
    };
    return ctx.git.exclusive(ctx.project, async () => {
      const remote = asRemote((await remoteOf(ctx)) ?? row);
      const commit = await ctx.git.push(ctx.project, remote, credential, author, message);
      if (commit) {
        await synced(ctx, commit, remote.untracked, "push");
        await ctx.store.audit(ctx.project, ctx.user.id, "git.push", { commit });
      }
      return { commit };
    });
  }),
  route<InProject>("POST", /^git\/unlink$/, async (ctx) => {
    await ctx.need("edit");
    await ctx.git.exclusive(ctx.project, async () => {
      await ctx.store.db.run(sql`DELETE FROM git_remotes WHERE project=${ctx.project}`);
      await ctx.git.remove(ctx.project);
    });
    await ctx.store.audit(ctx.project, ctx.user.id, "git.unlink", {});
    return { ok: true };
  }),
];
