import { useCallback, useEffect, useState } from "react";
import type {
  Account,
  IssuedPassword,
  IssuedSignupInvite,
  RegistrationMode,
  SignupInvite,
} from "../shared/api";
import { api, errorText } from "./api";
import { copyText } from "./clipboard";
import { useI18n } from "./i18n";

type Tab = "pending" | "users" | "invites" | "settings";

/** Administration: approve registrations, manage accounts and invitations, set registration. */
export function AdminConsole({ me }: { me: string }) {
  const { t } = useI18n();
  const [users, setUsers] = useState<Account[]>([]),
    [tab, setTab] = useState<Tab>("pending"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const reload = useCallback(async () => setUsers(await api<Account[]>("/admin/users")), []);
  useEffect(() => {
    void reload().catch((e) => setError(errorText(e)));
  }, [reload]);
  /** Runs an action, then reloads the user list; errors show above the tabs. */
  const run = useCallback(
    (action: () => Promise<void>) => {
      setBusy(true);
      setError("");
      void action()
        .then(reload)
        .catch((e) => setError(errorText(e)))
        .finally(() => setBusy(false));
    },
    [reload],
  );
  const pending = users.filter((u) => u.pending);
  const tabs: [Tab, string][] = [
    ["pending", `${t("console.tab.pending")}${pending.length ? ` (${pending.length})` : ""}`],
    ["users", t("console.tab.users")],
    ["invites", t("console.tab.invites")],
    ["settings", t("console.tab.settings")],
  ];
  return (
    <main className="dashboard page">
      <div className="page-head">
        <h1>{t("console.title")}</h1>
        <p className="muted">{t("console.lead")}</p>
      </div>
      <div className="auth-tabs console-tabs" role="tablist">
        {tabs.map(([name, label]) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "selected" : ""}
            onClick={() => setTab(name)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {tab === "pending" && <Pending users={pending} busy={busy} run={run} />}
      {tab === "users" && (
        <Users users={users.filter((u) => !u.pending)} me={me} busy={busy} run={run} />
      )}
      {tab === "invites" && <Invites onError={setError} />}
      {tab === "settings" && <Settings onError={setError} />}
    </main>
  );
}

type Run = (action: () => Promise<void>) => void;

function Pending({ users, busy, run }: { users: Account[]; busy: boolean; run: Run }) {
  const { t, locale } = useI18n();
  if (!users.length) return <p className="muted">{t("console.pendingEmpty")}</p>;
  return (
    <div className="pending-list">
      {users.map((u) => (
        <article className="pending-card" key={u.id}>
          <div>
            <strong>{u.username}</strong>
            <p>{u.note || <span className="muted">{t("console.noNote")}</span>}</p>
            <span className="muted">
              {t("console.registered", {
                time: new Date(u.created).toLocaleString(locale === "zh" ? "zh-CN" : "en"),
              })}
            </span>
          </div>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(`/admin/users/${u.id}/approve`, {});
                })
              }
            >
              {t("console.approve")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirm(t("console.rejectConfirm", { name: u.username })))
                  run(async () => {
                    await api(`/admin/users/${u.id}/reject`, {});
                  });
              }}
            >
              {t("console.reject")}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function Users({
  users,
  me,
  busy,
  run,
}: {
  users: Account[];
  me: string;
  busy: boolean;
  run: Run;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(""),
    [admin, setAdmin] = useState(false),
    [issued, setIssued] = useState<Required<IssuedPassword> | null>(null);
  return (
    <>
      <form
        className="new-project row"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            setIssued(
              await api<{ username: string; password: string }>("/admin/users", {
                username: name,
                admin,
              }),
            );
            setName("");
            setAdmin(false);
          });
        }}
      >
        <input
          aria-label={t("admin.newUser")}
          placeholder={t("admin.newUser")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <label className="row">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          {t("admin.isAdmin")}
        </label>
        <button className="primary" type="submit" disabled={busy}>
          {t("admin.create")}
        </button>
      </form>
      {issued && (
        <div className="banner" role="status">
          {t("admin.issued", { name: issued.username })} <code>{issued.password}</code>
          {t("admin.issuedNote")}
          <button type="button" onClick={() => void copyText(issued.password)}>
            {t("admin.copy")}
          </button>
          <button type="button" onClick={() => setIssued(null)}>
            ×
          </button>
        </div>
      )}
      <table className="admin-users">
        <thead>
          <tr>
            <th>{t("admin.col.username")}</th>
            <th>{t("admin.col.kind")}</th>
            <th>{t("admin.col.state")}</th>
            <th>{t("admin.col.projects")}</th>
            <th>{t("admin.col.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.disabled ? "muted" : ""}>
              <td>
                {u.username}
                {u.note && <div className="muted small">{u.note}</div>}
              </td>
              <td>{u.admin ? t("admin.kind.admin") : t("admin.kind.member")}</td>
              <td>
                {u.disabled
                  ? t("admin.state.disabled")
                  : u.mustChange
                    ? t("admin.state.mustChange")
                    : t("admin.state.active")}
              </td>
              <td>{u.projects}</td>
              <td>
                <div className="row">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(t("admin.resetConfirm", { name: u.username })))
                        run(async () => {
                          const r = await api<{ password: string }>(
                            `/admin/users/${u.id}/reset`,
                            {},
                          );
                          setIssued({ username: u.username, password: r.password });
                        });
                    }}
                  >
                    {t("admin.reset")}
                  </button>
                  {u.id !== me && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api(`/admin/users/${u.id}`, { admin: !u.admin }, "PATCH");
                          })
                        }
                      >
                        {u.admin ? t("admin.revokeAdmin") : t("admin.makeAdmin")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            u.disabled ||
                            confirm(t("admin.disableConfirm", { name: u.username }))
                          )
                            run(async () => {
                              await api(`/admin/users/${u.id}`, { disabled: !u.disabled }, "PATCH");
                            });
                        }}
                      >
                        {u.disabled ? t("admin.enable") : t("admin.disable")}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => {
                          const message = u.soleOwned
                            ? t("console.deleteTransferConfirm", {
                                name: u.username,
                                count: u.soleOwned,
                              })
                            : t("console.deleteConfirm", { name: u.username });
                          if (confirm(message))
                            run(async () => {
                              await api(`/admin/users/${u.id}`, { transfer: true }, "DELETE");
                            });
                        }}
                      >
                        {t("console.delete")}
                      </button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Invites({ onError }: { onError: (message: string) => void }) {
  const { t, locale } = useI18n();
  const [invites, setInvites] = useState<SignupInvite[]>([]),
    [note, setNote] = useState(""),
    [days, setDays] = useState(7),
    [uses, setUses] = useState(1),
    [issued, setIssued] = useState<IssuedSignupInvite | null>(null),
    [busy, setBusy] = useState(false);
  const reload = useCallback(
    async () => setInvites(await api<SignupInvite[]>("/admin/invites")),
    [],
  );
  useEffect(() => {
    void reload().catch((e) => onError(errorText(e)));
  }, [reload, onError]);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    onError("");
    void action()
      .then(reload)
      .catch((e) => onError(errorText(e)))
      .finally(() => setBusy(false));
  };
  const date = (time: number) =>
    new Date(time).toLocaleDateString(locale === "zh" ? "zh-CN" : "en");
  return (
    <>
      <p className="muted">{t("console.inviteLead")}</p>
      <form
        className="new-project row"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            setIssued(await api<IssuedSignupInvite>("/admin/invites", { note, days, uses }));
            setNote("");
          });
        }}
      >
        <input
          aria-label={t("console.inviteNote")}
          placeholder={t("console.inviteNote")}
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
        />
        <label className="row">
          {t("console.inviteDays")}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 30, 90].map((n) => (
              <option key={n} value={n}>
                {t("console.days", { count: n })}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          {t("console.inviteUses")}
          <input
            type="number"
            min={1}
            max={100}
            value={uses}
            onChange={(e) => setUses(Number(e.target.value))}
            className="narrow"
          />
        </label>
        <button className="primary" type="submit" disabled={busy}>
          {t("console.createInvite")}
        </button>
      </form>
      {issued && (
        <div className="banner" role="status">
          {t("console.inviteIssued")} <code>{issued.url}</code>
          <button type="button" onClick={() => void copyText(issued.url)}>
            {t("admin.copy")}
          </button>
          <button type="button" onClick={() => setIssued(null)}>
            ×
          </button>
        </div>
      )}
      {!invites.length && <p className="muted">{t("console.invitesEmpty")}</p>}
      {invites.map((invite) => (
        <article className="pending-card" key={invite.id}>
          <div>
            <strong>{invite.note || "—"}</strong>
            <span className="muted">
              {t("console.inviteRow", {
                used: invite.used,
                uses: invite.uses,
                expires: date(invite.expires),
                by: invite.createdBy ?? "—",
              })}
            </span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (confirm(t("console.revokeConfirm")))
                run(async () => {
                  await api(`/admin/invites/${invite.id}`, {}, "DELETE");
                });
            }}
          >
            {t("console.revoke")}
          </button>
        </article>
      ))}
    </>
  );
}

function Settings({ onError }: { onError: (message: string) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<RegistrationMode | null>(null),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ registration: RegistrationMode }>("/admin/settings")
      .then((s) => setMode(s.registration))
      .catch((e) => onError(errorText(e)));
  }, [onError]);
  if (!mode) return null;
  const options: [RegistrationMode, string, string][] = [
    ["approval", t("console.mode.approval"), t("console.mode.approvalHint")],
    ["open", t("console.mode.open"), t("console.mode.openHint")],
    ["closed", t("console.mode.closed"), t("console.mode.closedHint")],
  ];
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setSaved(false);
        onError("");
        void api("/admin/settings", { registration: mode }, "PUT")
          .then(() => setSaved(true))
          .catch((e) => onError(errorText(e)))
          .finally(() => setBusy(false));
      }}
    >
      <p className="muted">{t("console.settingsLead")}</p>
      {options.map(([value, label, hint]) => (
        <label key={value} className="choice">
          <input
            type="radio"
            name="registration"
            checked={mode === value}
            onChange={() => {
              setMode(value);
              setSaved(false);
            }}
          />
          <span>
            <strong>{label}</strong>
            <span className="muted">{hint}</span>
          </span>
        </label>
      ))}
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          {t("console.save")}
        </button>
        {saved && <span className="muted">{t("console.saved")}</span>}
      </div>
    </form>
  );
}
