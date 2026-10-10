import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSummary, PublicUser } from "../shared/api";
import { ChangePassword } from "./account";
import { AdminConsole } from "./admin";
import { api } from "./api";
import { AuthPage } from "./auth";
import { Dashboard } from "./dashboard";
import { DesktopPage } from "./desktop";
import { useI18n } from "./i18n";
import { FriendsPage, ProfilePage } from "./profile";
import { TemplateGallery } from "./templates";
import { type Page, TopNav } from "./top-nav";

// The workbench (editor, PDF preview, file tree) loads when a project is first opened, or
// at once when the address names one, alongside the account (slow links save a round trip).
const loadWorkspace = () => import("./workspace/workspace");
const Workspace = lazy(() => loadWorkspace().then((m) => ({ default: m.Workspace })));
const projectInAddress =
  typeof location === "undefined" ? null : new URL(location.href).searchParams.get("project");
if (projectInAddress) void loadWorkspace().catch(() => {});

export function App() {
  const { t } = useI18n();
  const [user, setUser] = useState<PublicUser | null>(null),
    [ready, setReady] = useState(false),
    [project, setProject] = useState<ProjectSummary | null>(null),
    [view, setView] = useState<Page>(() => {
      const params = new URL(location.href).searchParams;
      if (params.has("templates") || params.has("template")) return "templates";
      if (params.has("friends")) return "friends";
      if (params.has("desktop")) return "desktop";
      return params.has("profile") ? "profile" : "projects";
    }),
    // `/?template=<id>` shows one template in the gallery.
    [template, setTemplate] = useState<string | null>(() =>
      new URL(location.href).searchParams.get("template"),
    );
  // Invitation links show the sign-in page even when signed in, to join with any account.
  const [link, setLink] = useState(() => {
    const params = new URL(location.href).searchParams;
    return params.has("invite") || params.has("signup");
  });
  // `/?project=<id>` opens a project directly, e.g. from the desktop app: asked for together
  // with the account, so the dashboard never shows in between.
  const [wanted] = useState(() => new URL(location.href).searchParams.get("project"));
  const opened = useRef(false);
  const summary = useCallback(
    (id: string) => api<ProjectSummary>(`/projects/${encodeURIComponent(id)}`).catch(() => null),
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival.
  useEffect(() => {
    const opening = wanted ? summary(wanted) : null;
    void api<PublicUser>("/me")
      .then(async (me) => {
        const found = !me.mustChange && opening ? await opening : null;
        opened.current = !me.mustChange;
        setUser(me);
        if (found) setProject(found);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  // Signing in (or changing the temporary password) on the way opens it too.
  useEffect(() => {
    if (!user || user.mustChange || !wanted || opened.current) return;
    opened.current = true;
    void summary(wanted).then((found) => found && setProject(found));
  }, [user, wanted, summary]);
  const openProject = useCallback((next: ProjectSummary | null) => {
    setProject(next);
    history.replaceState(null, "", next ? `/?project=${encodeURIComponent(next.id)}` : "/");
  }, []);
  const navigate = useCallback((next: Page) => {
    setView(next);
    if (next === "templates") setTemplate(null);
    history.replaceState(null, "", next === "projects" ? "/" : `/?${next}`);
  }, []);
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
  const page = view === "admin" && !user.admin ? "projects" : view;
  return (
    <div className="app-shell">
      <TopNav
        user={user}
        page={page}
        onNavigate={navigate}
        onSignOut={() => void api("/logout", {}).finally(() => setUser(null))}
      />
      {page === "admin" ? (
        <AdminConsole me={user.id} />
      ) : page === "templates" ? (
        <TemplateGallery
          user={user}
          initial={template}
          onOpen={(next) => {
            setView("projects");
            openProject(next);
          }}
        />
      ) : page === "friends" ? (
        <FriendsPage />
      ) : page === "desktop" ? (
        <DesktopPage />
      ) : page === "profile" ? (
        <ProfilePage user={user} onUser={setUser} />
      ) : (
        <Dashboard
          user={user}
          onOpen={openProject}
          onTemplates={(id) => {
            setTemplate(id ?? null);
            setView("templates");
          }}
        />
      )}
    </div>
  );
}
