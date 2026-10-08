import { useCallback, useEffect, useState } from "react";
import type { ProjectSummary, PublicUser } from "../shared/api";
import { AdminPanel, ChangePassword } from "./account";
import { api } from "./api";
import { useI18n } from "./i18n";
import { roleKey } from "./labels";
import { LanguageSwitch } from "./language-switch";
import { useAction } from "./use-action";
import { Workspace } from "./workspace/workspace";

function SignIn({
  invite,
  onSignedIn,
}: {
  invite: string | null;
  onSignedIn: (user: PublicUser) => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  return (
    <div className="auth">
      <div className="row spread">
        <span className="eyebrow">WRITER / COLLABORATION</span>
        <LanguageSwitch />
      </div>
      <h1>{invite ? t("signIn.titleJoin") : t("signIn.title")}</h1>
      <p>{t("signIn.lead")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const me = await api<PublicUser>(invite ? "/join" : "/login", {
              username,
              password,
              ...(invite ? { token: invite } : {}),
            });
            setPassword("");
            if (invite) {
              history.replaceState(null, "", "/");
              location.reload();
            } else onSignedIn(me);
          });
        }}
      >
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
            autoComplete={invite ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={12}
            required
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? t("common.working") : invite ? t("signIn.join") : t("signIn.submit")}
        </button>
      </form>
      <p className="muted">{t("signIn.storage")}</p>
    </div>
  );
}

function Projects({
  user,
  onOpen,
  onView,
  onSignedOut,
}: {
  user: PublicUser;
  onOpen: (project: ProjectSummary) => void;
  onView: (view: "admin" | "password") => void;
  onSignedOut: () => void;
}) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<ProjectSummary[]>([]),
    [name, setName] = useState("");
  const { busy, error, setError, run } = useAction();
  useEffect(() => {
    void api<ProjectSummary[]>("/projects")
      .then(setProjects)
      .catch((e) => setError(String(e)));
  }, [setError]);
  return (
    <main className="dashboard">
      <header>
        <div>
          <span className="eyebrow">WRITER / WORKSPACE</span>
          <h1>{t("projects.title")}</h1>
        </div>
        <div className="row">
          <LanguageSwitch />
          <span>{user.name}</span>
          {user.admin && (
            <button type="button" onClick={() => onView("admin")}>
              {t("projects.admin")}
            </button>
          )}
          <button type="button" onClick={() => onView("password")}>
            {t("projects.changePassword")}
          </button>
          <button
            type="button"
            onClick={() =>
              run(async () => {
                await api("/logout", {});
                onSignedOut();
              })
            }
          >
            {t("projects.signOut")}
          </button>
        </div>
      </header>
      <form
        className="new-project row"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            onOpen(await api<ProjectSummary>("/projects", { name }));
            setName("");
          });
        }}
      >
        <input
          aria-label={t("projects.newName")}
          placeholder={t("projects.newName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button className="primary" disabled={busy} type="submit">
          {t("projects.create")}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="projects">
        {projects.map((p) => (
          <button className="project-card" key={p.id} type="button" onClick={() => onOpen(p)}>
            <span className="eyebrow">{t(roleKey[p.role])}</span>
            <h2>{p.name}</h2>
            <span className="muted">{t("projects.open")}</span>
          </button>
        ))}
      </div>
      {!projects.length && <p className="muted">{t("projects.empty")}</p>}
    </main>
  );
}

export function App() {
  const { t } = useI18n();
  const [user, setUser] = useState<PublicUser | null>(null),
    [ready, setReady] = useState(false),
    [project, setProject] = useState<ProjectSummary | null>(null),
    [view, setView] = useState<"projects" | "admin" | "password">("projects");
  const [invite] = useState(() => new URL(location.href).searchParams.get("invite"));
  // `/?project=<id>` opens a project directly, e.g. from the desktop app.
  const [wanted] = useState(() => new URL(location.href).searchParams.get("project"));
  useEffect(() => {
    void api<PublicUser>("/me")
      .then(setUser)
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!user || user.mustChange || !wanted) return;
    void api<ProjectSummary[]>("/projects")
      .then((list) => {
        const found = list.find((p) => p.id === wanted);
        if (found) setProject(found);
      })
      .catch(() => {});
  }, [user, wanted]);
  const openProject = useCallback((next: ProjectSummary | null) => {
    setProject(next);
    history.replaceState(null, "", next ? `/?project=${encodeURIComponent(next.id)}` : "/");
  }, []);
  const back = useCallback(() => setView("projects"), []);
  if (!ready)
    return (
      <div className="auth">
        <h1>Writer</h1>
        <p>{t("common.loading")}</p>
      </div>
    );
  if (!user || invite) return <SignIn invite={invite} onSignedIn={setUser} />;
  if (user.mustChange)
    return (
      <div className="auth">
        <ChangePassword forced onDone={() => setUser({ ...user, mustChange: false })} />
      </div>
    );
  if (view === "admin" && user.admin) return <AdminPanel me={user.id} onBack={back} />;
  if (view === "password")
    return (
      <div className="auth">
        <ChangePassword onDone={back} onCancel={back} />
      </div>
    );
  if (project) return <Workspace project={project} user={user} onBack={() => openProject(null)} />;
  return (
    <Projects user={user} onOpen={openProject} onView={setView} onSignedOut={() => setUser(null)} />
  );
}
