import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export function ChangePassword({
  forced,
  onDone,
  onCancel,
}: {
  forced?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
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
          setError("两次输入的新密码不一致");
          return;
        }
        setBusy(true);
        setError("");
        void api("/me/password", { current, next })
          .then(onDone)
          .catch((e) => setError(String(e)))
          .finally(() => setBusy(false));
      }}
    >
      <h2>{forced ? "请先设置自己的密码" : "修改密码"}</h2>
      {forced && <p className="muted">管理员给你的是临时密码，设置新密码后才能继续使用。</p>}
      <label>
        {forced ? "临时密码" : "当前密码"}
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </label>
      <label>
        新密码（至少 12 位）
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
        再次输入新密码
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
          {busy ? "保存中…" : "保存新密码"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
      <p className="muted">修改后，你在其他设备上的登录会退出。</p>
    </form>
  );
}

type Account = {
  id: string;
  username: string;
  admin: boolean;
  disabled: boolean;
  mustChange: boolean;
  created: number;
  projects: number;
};
export function AdminPanel({ me, onBack }: { me: string; onBack: () => void }) {
  const [users, setUsers] = useState<Account[]>([]),
    [name, setName] = useState(""),
    [admin, setAdmin] = useState(false),
    [issued, setIssued] = useState<{ username: string; password: string } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const reload = useCallback(async () => setUsers(await api<Account[]>("/admin/users")), []);
  useEffect(() => {
    void reload().catch((e) => setError(String(e)));
  }, [reload]);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    void action()
      .then(reload)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <main className="dashboard">
      <header>
        <div>
          <span className="eyebrow">WRITER / ADMIN</span>
          <h1>用户管理</h1>
        </div>
        <button type="button" onClick={onBack}>
          ← 返回项目
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
          aria-label="新用户名"
          placeholder="新用户名"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <label className="row">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          管理员
        </label>
        <button className="primary" type="submit" disabled={busy}>
          创建账号
        </button>
      </form>
      {issued && (
        <div className="banner" role="status">
          {issued.username} 的临时密码：<code>{issued.password}</code>
          （只显示这一次，首次登录后需修改）
          <button type="button" onClick={() => void navigator.clipboard.writeText(issued.password)}>
            复制
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
            <th>用户名</th>
            <th>身份</th>
            <th>状态</th>
            <th>项目</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.disabled ? "muted" : ""}>
              <td>{u.username}</td>
              <td>{u.admin ? "管理员" : "成员"}</td>
              <td>{u.disabled ? "已停用" : u.mustChange ? "待改临时密码" : "正常"}</td>
              <td>{u.projects}</td>
              <td className="row">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`重置 ${u.username} 的密码？对方会被强制退出登录。`))
                      run(async () => {
                        const r = await api<{ password: string }>(`/admin/users/${u.id}/reset`, {});
                        setIssued({ username: u.username, password: r.password });
                      });
                  }}
                >
                  重置密码
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
                      {u.admin ? "取消管理员" : "设为管理员"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (u.disabled || confirm(`停用 ${u.username}？对方将无法登录。`))
                          run(async () => {
                            await api(`/admin/users/${u.id}`, { disabled: !u.disabled }, "PATCH");
                          });
                      }}
                    >
                      {u.disabled ? "启用" : "停用"}
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
