import { useCallback, useEffect, useState } from "react";
import type { Account, IssuedPassword } from "../shared/api";
import { api, errorText } from "./api";
import { copyText } from "./clipboard";
import { useI18n } from "./i18n";

export function ChangePassword({
  forced,
  onDone,
  onCancel,
}: {
  forced?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [again, setAgain] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="account-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (next !== again) {
          setError(t("account.mismatch"));
          return;
        }
        setBusy(true);
        setError("");
        void api("/me/password", { current, next })
          .then(onDone)
          .catch((e) => setError(errorText(e)))
          .finally(() => setBusy(false));
      }}
    >
      <h2>{forced ? t("account.forcedTitle") : t("account.title")}</h2>
      {forced && <p className="muted">{t("account.forcedLead")}</p>}
      <label>
        {forced ? t("account.temporary") : t("account.current")}
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </label>
      <label>
        {t("account.new")}
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </label>
      <label>
        {t("account.repeat")}
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          required
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? t("account.saving") : t("account.save")}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        )}
      </div>
      <p className="muted">{t("account.signOutOthers")}</p>
    </form>
  );
}

export function AdminPanel({ me, onBack }: { me: string; onBack: () => void }) {
  const { t } = useI18n();
  const [users, setUsers] = useState<Account[]>([]),
    [name, setName] = useState(""),
    [admin, setAdmin] = useState(false),
    [issued, setIssued] = useState<Required<IssuedPassword> | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const reload = useCallback(async () => setUsers(await api<Account[]>("/admin/users")), []);
  useEffect(() => {
    void reload().catch((e) => setError(errorText(e)));
  }, [reload]);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    void action()
      .then(reload)
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <main className="dashboard">
      <header>
        <div>
          <span className="eyebrow">WRITER / ADMIN</span>
          <h1>{t("admin.title")}</h1>
        </div>
        <button type="button" onClick={onBack}>
          {t("admin.back")}
        </button>
      </header>
      <form
        className="new-project row"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const result = await api<{ username: string; password: string }>("/admin/users", {
              username: name,
              admin,
            });
            setIssued(result);
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
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
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
              <td>{u.username}</td>
              <td>{u.admin ? t("admin.kind.admin") : t("admin.kind.member")}</td>
              <td>
                {u.disabled
                  ? t("admin.state.disabled")
                  : u.mustChange
                    ? t("admin.state.mustChange")
                    : t("admin.state.active")}
              </td>
              <td>{u.projects}</td>
              <td className="row">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t("admin.resetConfirm", { name: u.username })))
                      run(async () => {
                        const r = await api<{ password: string }>(`/admin/users/${u.id}/reset`, {});
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
                        if (u.disabled || confirm(t("admin.disableConfirm", { name: u.username })))
                          run(async () => {
                            await api(`/admin/users/${u.id}`, { disabled: !u.disabled }, "PATCH");
                          });
                      }}
                    >
                      {u.disabled ? t("admin.enable") : t("admin.disable")}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
