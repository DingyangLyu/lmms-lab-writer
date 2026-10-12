/**
 * Git sync from the project menu: link the project to a branch of a repository (GitHub,
 * GitLab, Gitee…), pull its commits in and push the project's changes. Each member pushes and
 * pulls with their own access token or SSH key for the host, saved here.
 */
import { useCallback, useEffect, useState } from "react";
import type { GitCredentialInfo, GitPullResult, GitStatus } from "../../shared/api";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { Btn, Dialog, Input, TextArea } from "./ui";

/** The host and kind of access an address needs, as the server reads it (git.ts). */
function hostOf(url: string): { host: string; kind: "token" | "ssh" } | null {
  const scp = /^[\w.-]+@([\w.-]+):/.exec(url.trim());
  if (scp?.[1]) return { host: scp[1].toLowerCase(), kind: "ssh" };
  try {
    const u = new URL(url.trim());
    if (u.protocol === "https:") return { host: u.hostname.toLowerCase(), kind: "token" };
    if (u.protocol === "ssh:") return { host: u.hostname.toLowerCase(), kind: "ssh" };
  } catch {}
  return null;
}

export function GitDialog({ ws, onClose }: { ws: WorkspaceContext; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { prefix, canEdit, busy, run, report } = ws;
  const [status, setStatus] = useState<GitStatus | null>(null),
    [credentials, setCredentials] = useState<GitCredentialInfo[]>([]),
    [url, setUrl] = useState(""),
    [branch, setBranch] = useState("main"),
    [message, setMessage] = useState(""),
    [editing, setEditing] = useState(false);
  const load = useCallback(async () => {
    const [next, mine] = await Promise.all([
      api<GitStatus>(`${prefix}/git`),
      api<GitCredentialInfo[]>("/me/git"),
    ]);
    setStatus(next);
    setCredentials(mine);
    if (next.remote) {
      setUrl(next.remote.url);
      setBranch(next.remote.branch);
    }
  }, [prefix]);
  useEffect(() => {
    load().catch((e) => report(errorText(e)));
  }, [load, report]);

  const remote = status?.remote ?? null;
  const target = hostOf(url);
  const needs =
    target && !credentials.some((c) => c.host === target.host && c.kind === target.kind)
      ? target
      : null;
  const when = (ms: number) => new Date(ms).toLocaleString(locale === "zh" ? "zh-CN" : "en");
  const pulled = (result: GitPullResult) => {
    const parts = [t("git.pulled", { applied: result.applied })];
    if (result.proposals) parts.push(t("git.pulledProposals", { count: result.proposals }));
    if (result.skipped.length)
      parts.push(
        t("git.pulledSkipped", {
          list: result.skipped.map((s) => `${s.path}（${s.reason}）`).join("、"),
        }),
      );
    ws.notify(parts.join(" "));
  };

  return (
    <Dialog title={t("git.title")} onClose={onClose}>
      {!status ? (
        <p className="text-muted">{t("git.loading")}</p>
      ) : (
        <div className="space-y-4 text-xs">
          {remote && !editing ? (
            <section className="space-y-2">
              <p className="break-all">
                <span className="text-muted">{t("git.repository")}：</span>
                {remote.url} · <code>{remote.branch}</code>
              </p>
              <p className="text-muted">
                {remote.synced
                  ? t(remote.action === "push" ? "git.lastPush" : "git.lastPull", {
                      name: remote.syncedBy ?? "",
                      time: when(remote.synced),
                      commit: remote.base?.slice(0, 7) ?? "",
                    })
                  : t("git.neverSynced")}
                {status.changed !== null && ` · ${t("git.changed", { count: status.changed })}`}
              </p>
              {!!remote.untracked && (
                <p className="text-muted">{t("git.untracked", { count: remote.untracked })}</p>
              )}
              {!status.hasCredential && remote.kind && (
                <p className="text-red-600">
                  {t(remote.kind === "token" ? "git.needToken" : "git.needKey", {
                    host: remote.host,
                  })}
                </p>
              )}
              <Input
                aria-label={t("git.message")}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t("git.message")}
                className="w-full"
              />
              <div className="flex flex-wrap gap-2">
                <Btn
                  disabled={!canEdit || busy || !status.hasCredential}
                  onClick={() =>
                    run(async () => {
                      pulled(await api<GitPullResult>(`${prefix}/git/pull`, {}));
                      await Promise.all([load(), ws.reload()]);
                    })
                  }
                >
                  {remote.base ? t("git.pull") : t("git.import")}
                </Btn>
                <Btn
                  tone="solid"
                  disabled={!canEdit || busy || !status.hasCredential}
                  onClick={() =>
                    run(async () => {
                      const { commit } = await api<{ commit: string | null }>(
                        `${prefix}/git/push`,
                        {
                          message: message.trim(),
                        },
                      );
                      ws.notify(
                        commit
                          ? t("git.pushed", { commit: commit.slice(0, 7) })
                          : t("git.nothingToPush"),
                      );
                      setMessage("");
                      await load();
                    })
                  }
                >
                  {t("git.push")}
                </Btn>
                <Btn disabled={!canEdit || busy} onClick={() => setEditing(true)}>
                  {t("git.change")}
                </Btn>
                <Btn
                  tone="danger"
                  disabled={!canEdit || busy}
                  onClick={() => {
                    if (confirm(t("git.unlinkConfirm")))
                      run(async () => {
                        await api(`${prefix}/git/unlink`, {});
                        await load();
                      });
                  }}
                >
                  {t("git.unlink")}
                </Btn>
              </div>
              <p className="text-muted">{t("git.howItWorks")}</p>
            </section>
          ) : (
            <section className="space-y-2">
              <p className="text-muted">{t("git.intro")}</p>
              <Input
                aria-label={t("git.repository")}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/lab/paper.git  ·  git@gitee.com:lab/paper.git"
                className="w-full font-mono"
              />
              <Input
                aria-label={t("git.branch")}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={t("git.branch")}
                className="w-full font-mono"
              />
              <div className="flex gap-2">
                <Btn
                  tone="solid"
                  disabled={!canEdit || busy || !url.trim() || !branch.trim() || !!needs}
                  onClick={() =>
                    run(async () => {
                      const { exists } = await api<{ exists: boolean }>(`${prefix}/git/link`, {
                        url: url.trim(),
                        branch: branch.trim(),
                      });
                      ws.notify(t(exists ? "git.linkedExisting" : "git.linkedEmpty"));
                      setEditing(false);
                      await load();
                    })
                  }
                >
                  {t("git.link")}
                </Btn>
                {editing && <Btn onClick={() => setEditing(false)}>{t("git.cancel")}</Btn>}
              </div>
            </section>
          )}
          {needs && (editing || !remote) && (
            <CredentialForm host={needs.host} kind={needs.kind} onSaved={load} ws={ws} />
          )}
          {!needs && remote && !status.hasCredential && remote.kind && (
            <CredentialForm host={remote.host} kind={remote.kind} onSaved={load} ws={ws} />
          )}
          {!!credentials.length && (
            <section className="space-y-1 border-t border-border pt-3">
              <h3 className="font-semibold">{t("git.myCredentials")}</h3>
              {credentials.map((c) => (
                <p key={`${c.host}:${c.kind}`} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {c.host} · {t(c.kind === "token" ? "git.kindToken" : "git.kindKey")}
                    {c.username ? ` · ${c.username}` : ""}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-muted hover:text-accent"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api("/me/git/remove", { host: c.host, kind: c.kind });
                        await load();
                      })
                    }
                  >
                    {t("git.remove")}
                  </button>
                </p>
              ))}
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Saves the member's access for one host: an access token for https, a private key for ssh. */
function CredentialForm({
  host,
  kind,
  onSaved,
  ws,
}: {
  host: string;
  kind: "token" | "ssh";
  onSaved: () => Promise<void>;
  ws: WorkspaceContext;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState(""),
    [secret, setSecret] = useState(""),
    [authorName, setAuthorName] = useState(""),
    [authorEmail, setAuthorEmail] = useState("");
  return (
    <section className="space-y-2 border-t border-border pt-3">
      <h3 className="font-semibold">
        {t("git.credentialFor", { host })} · {t(kind === "token" ? "git.kindToken" : "git.kindKey")}
      </h3>
      <p className="text-muted">{t(kind === "token" ? "git.tokenHelp" : "git.keyHelp")}</p>
      {kind === "token" && (
        <Input
          aria-label={t("git.username")}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t("git.username")}
          className="w-full"
        />
      )}
      {kind === "token" ? (
        <Input
          aria-label={t("git.token")}
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={t("git.token")}
          className="w-full font-mono"
        />
      ) : (
        <TextArea
          aria-label={t("git.key")}
          rows={5}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          className="w-full font-mono"
        />
      )}
      <div className="flex gap-2">
        <Input
          aria-label={t("git.authorName")}
          value={authorName}
          onChange={(e) => setAuthorName(e.target.value)}
          placeholder={t("git.authorName")}
          className="min-w-0 flex-1"
        />
        <Input
          aria-label={t("git.authorEmail")}
          value={authorEmail}
          onChange={(e) => setAuthorEmail(e.target.value)}
          placeholder={t("git.authorEmail")}
          className="min-w-0 flex-1"
        />
      </div>
      <Btn
        tone="solid"
        disabled={ws.busy || !secret.trim()}
        onClick={() =>
          ws.run(async () => {
            await api("/me/git", { host, kind, username, secret, authorName, authorEmail });
            setSecret("");
            ws.notify(t("git.credentialSaved", { host }));
            await onSaved();
          })
        }
      >
        {t("git.saveCredential")}
      </Btn>
    </section>
  );
}
