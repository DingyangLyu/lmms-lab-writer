import { useCallback, useEffect, useState } from "react";
import type { ProjectSummary, PublicUser } from "../shared/api";
import { AdminPanel, ChangePassword } from "./account";
import { api } from "./api";
import { roleName } from "./labels";
import { useAction } from "./use-action";
import { Workspace } from "./workspace/workspace";

function SignIn({
  invite,
  onSignedIn,
}: {
  invite: string | null;
  onSignedIn: (user: PublicUser) => void;
}) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  return (
    <div className="auth">
      <span className="eyebrow">WRITER / COLLABORATION</span>
      <h1>{invite ? "加入写作项目" : "共同写作"}</h1>
      <p>与合作者编辑同一份文稿，保留每次讨论和修改。</p>
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
          用户名
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label>
          密码
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
          {busy ? "处理中…" : invite ? "加入项目" : "登录"}
        </button>
      </form>
      <p className="muted">账号和文件保存在你部署的 Writer 服务中。</p>
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
          <h1>我的论文</h1>
        </div>
        <div className="row">
          <span>{user.name}</span>
          {user.admin && (
            <button type="button" onClick={() => onView("admin")}>
              用户管理
            </button>
          )}
          <button type="button" onClick={() => onView("password")}>
            修改密码
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
            退出登录
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
          aria-label="新项目名称"
          placeholder="新项目名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button className="primary" disabled={busy} type="submit">
          创建项目
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
            <span className="eyebrow">{roleName[p.role]}</span>
            <h2>{p.name}</h2>
            <span className="muted">打开文稿 →</span>
          </button>
        ))}
      </div>
      {!projects.length && <p className="muted">创建项目，或打开合作者发来的邀请链接。</p>}
    </main>
  );
}

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null),
    [ready, setReady] = useState(false),
    [project, setProject] = useState<ProjectSummary | null>(null),
    [view, setView] = useState<"projects" | "admin" | "password">("projects");
  const [invite] = useState(() => new URL(location.href).searchParams.get("invite"));
  useEffect(() => {
    void api<PublicUser>("/me")
      .then(setUser)
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  const back = useCallback(() => setView("projects"), []);
  if (!ready)
    return (
      <div className="auth">
        <h1>Writer</h1>
        <p>正在载入…</p>
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
  if (project) return <Workspace project={project} user={user} onBack={() => setProject(null)} />;
  return (
    <Projects user={user} onOpen={setProject} onView={setView} onSignedOut={() => setUser(null)} />
  );
}
