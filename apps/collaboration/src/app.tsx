import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { ProjectSummary, PublicUser } from "../shared/api";
import { ChangePassword } from "./account";
import { AdminConsole } from "./admin";
import { api } from "./api";
import { AuthPage } from "./auth";
import { Dashboard } from "./dashboard";
import { useI18n } from "./i18n";

// The workbench (editor, PDF preview, file tree) loads when a project is first opened.
const Workspace = lazy(() =>
  import("./workspace/workspace").then((m) => ({ default: m.Workspace })),
);

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
  if (project)
    return (
      <Suspense
        fallback={
          <div className="auth">
            <p>{t("common.loading")}</p>
          </div>
        }
      >
        <Workspace project={project} user={user} onBack={() => openProject(null)} />
      </Suspense>
    );
  return (
    <Dashboard
      user={user}
      onOpen={openProject}
      onView={setView}
      onSignedOut={() => setUser(null)}
    />
  );
}
