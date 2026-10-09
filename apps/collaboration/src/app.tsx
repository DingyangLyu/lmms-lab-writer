import { useCallback, useEffect, useState } from "react";
import type { ProjectSummary, PublicUser } from "../shared/api";
import { ChangePassword } from "./account";
import { AdminConsole } from "./admin";
import { api, errorText } from "./api";
import { AuthPage } from "./auth";
import { useI18n } from "./i18n";
import { roleKey } from "./labels";
import { LanguageSwitch } from "./language-switch";
import { useAction } from "./use-action";
import { Workspace } from "./workspace/workspace";

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
    [name, setName] = useState(""),
    [pending, setPending] = useState(0);
  const { busy, error, setError, run } = useAction();
  useEffect(() => {
    void api<ProjectSummary[]>("/projects")
      .then(setProjects)
      .catch((e) => setError(errorText(e)));
  }, [setError]);
  useEffect(() => {
    if (!user.admin) return;
    void api<{ pending: number }>("/admin/summary")
      .then((s) => setPending(s.pending))
      .catch(() => {});
  }, [user.admin]);
  return (
    <main className="dashboard">
      <header>
        <div>
          <img className="brand-small" src="/logo-small-light.svg" alt="Y-Writer" />
          <h1>{t("projects.title")}</h1>
        </div>
        <div className="row">
          <LanguageSwitch />
          <span>{user.name}</span>
          {user.admin && (
            <button type="button" onClick={() => onView("admin")}>
              {t("console.open")}
              {pending > 0 && <span className="count">{pending}</span>}
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
  // Invitation links show the sign-in page even when signed in, to join with any account.
  const [link, setLink] = useState(() => {
    const params = new URL(location.href).searchParams;
    return params.has("invite") || params.has("signup");
  });
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
        <h1>Y-Writer</h1>
        <p>{t("common.loading")}</p>
      </div>
    );
  if (!user || link)
    return (
      <AuthPage
        onSignedIn={(next) => {
          setUser(next);
          setLink(false);
        }}
      />
    );
  if (user.mustChange)
    return (
      <div className="auth">
        <ChangePassword forced onDone={() => setUser({ ...user, mustChange: false })} />
      </div>
    );
  if (view === "admin" && user.admin) return <AdminConsole me={user.id} onBack={back} />;
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
