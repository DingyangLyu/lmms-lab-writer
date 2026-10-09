import { type FormEvent, useEffect, useState } from "react";
import type { PublicUser, Registered, RegistrationInfo } from "../shared/api";
import { api } from "./api";
import { useI18n } from "./i18n";
import { LanguageSwitch } from "./language-switch";
import { useAction } from "./use-action";

const params = () => new URL(location.href).searchParams;
/** Drops `?invite=` / `?signup=` once used, so a reload does not reuse the link. */
const clearLink = () => history.replaceState(null, "", "/");

/**
 * Sign-in, registration and invitation links. `?invite=` is a project invitation (join with an
 * existing or new account); `?signup=` is an administrator's site invitation.
 */
export function AuthPage({ onSignedIn }: { onSignedIn: (user: PublicUser) => void }) {
  const { t } = useI18n();
  const [projectInvite] = useState(() => params().get("invite"));
  const [signup] = useState(() => params().get("signup"));
  const [info, setInfo] = useState<RegistrationInfo | null>(null);
  const [tab, setTab] = useState<"login" | "register">(signup ? "register" : "login");
  const [waiting, setWaiting] = useState<"register" | "join" | null>(null);
  useEffect(() => {
    void api<RegistrationInfo>(
      `/registration${signup ? `?invite=${encodeURIComponent(signup)}` : ""}`,
    )
      .then(setInfo)
      .catch(() => setInfo({ mode: "approval", invite: false }));
  }, [signup]);
  const finish = (result: Registered, kind: "register" | "join") => {
    clearLink();
    if (result.pending) setWaiting(kind);
    else onSignedIn(result.user);
  };
  const canRegister = !!info && (info.mode !== "closed" || info.invite);

  let body: React.ReactNode;
  if (waiting)
    body = (
      <div className="notice" role="status">
        <h2>{waiting === "join" ? t("auth.joinPendingTitle") : t("auth.pendingTitle")}</h2>
        <p>{waiting === "join" ? t("auth.joinPendingLead") : t("auth.pendingLead")}</p>
        <button
          type="button"
          onClick={() => {
            setWaiting(null);
            setTab("login");
          }}
        >
          {t("auth.backToLogin")}
        </button>
      </div>
    );
  else if (projectInvite)
    body = (
      <>
        <p className="muted">{t("auth.joinHint")}</p>
        <Credentials
          submit={t("signIn.join")}
          newPassword
          onSubmit={async (username, password) =>
            finish(
              await api<Registered>("/join", { username, password, token: projectInvite }),
              "join",
            )
          }
        />
      </>
    );
  else
    body = (
      <>
        {canRegister && (
          <div className="auth-tabs" role="tablist">
            {(["login", "register"] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                className={tab === name ? "selected" : ""}
                onClick={() => setTab(name)}
              >
                {t(name === "login" ? "auth.tab.login" : "auth.tab.register")}
              </button>
            ))}
          </div>
        )}
        {tab === "login" || !canRegister ? (
          <>
            <Credentials
              submit={t("signIn.submit")}
              onSubmit={async (username, password) =>
                onSignedIn(await api<PublicUser>("/login", { username, password }))
              }
            />
            <p className="muted">{t("auth.forgot")}</p>
            {info?.mode === "closed" && !info.invite && <p className="muted">{t("auth.closed")}</p>}
          </>
        ) : (
          <>
            {signup && info && !info.invite ? (
              <p className="error">{t("auth.inviteInvalid")}</p>
            ) : (
              <p className="muted">
                {info?.invite
                  ? t("auth.inviteHint")
                  : info?.mode === "open"
                    ? t("auth.openHint")
                    : t("auth.approvalHint")}
              </p>
            )}
            <Credentials
              submit={t("auth.register")}
              newPassword
              repeat
              note
              onSubmit={async (username, password, note) =>
                finish(
                  await api<Registered>("/register", {
                    username,
                    password,
                    note,
                    ...(signup && info?.invite ? { invite: signup } : {}),
                  }),
                  "register",
                )
              }
            />
          </>
        )}
      </>
    );
  return (
    <div className="auth">
      <div className="row spread">
        <span className="eyebrow">WRITER / COLLABORATION</span>
        <LanguageSwitch />
      </div>
      <h1>{projectInvite ? t("signIn.titleJoin") : t("signIn.title")}</h1>
      <p>{t("signIn.lead")}</p>
      {body}
      <p className="muted">{t("signIn.storage")}</p>
    </div>
  );
}

function Credentials({
  submit,
  newPassword,
  repeat,
  note,
  onSubmit,
}: {
  submit: string;
  newPassword?: boolean;
  repeat?: boolean;
  note?: boolean;
  onSubmit: (username: string, password: string, note: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [again, setAgain] = useState(""),
    [about, setAbout] = useState("");
  const { busy, error, setError, run } = useAction();
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (repeat && password !== again) {
      setError(t("auth.mismatch"));
      return;
    }
    run(async () => {
      await onSubmit(username.trim(), password, about.trim());
      setPassword("");
      setAgain("");
    });
  };
  return (
    <form onSubmit={send}>
      <label>
        {t("signIn.username")}
        <input
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </label>
      <label>
        {t("signIn.password")}
        <input
          type="password"
          autoComplete={newPassword ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          // Existing accounts sign in whatever their password; new ones need 12 characters.
          minLength={repeat ? 12 : undefined}
          placeholder={repeat ? t("auth.passwordHint") : undefined}
          required
        />
      </label>
      {repeat && (
        <label>
          {t("auth.repeat")}
          <input
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            required
          />
        </label>
      )}
      {note && (
        <label>
          {t("auth.note")}
          <textarea
            rows={2}
            maxLength={500}
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder={t("auth.notePlaceholder")}
          />
        </label>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" type="submit" disabled={busy}>
        {busy ? t("common.working") : submit}
      </button>
    </form>
  );
}
