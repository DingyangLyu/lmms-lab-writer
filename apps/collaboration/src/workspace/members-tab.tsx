import { useState } from "react";
import type { Invite, Member, Role } from "../../shared/api";
import { api } from "../api";
import { roleName } from "../labels";
import type { WorkspaceContext } from "./context";

export function MembersTab({
  ws,
  members,
  onDeleted,
}: {
  ws: WorkspaceContext;
  members: Member[];
  onDeleted: () => void;
}) {
  const [inviteRole, setInviteRole] = useState<Role>("editor"),
    [inviteLink, setInviteLink] = useState("");
  const { prefix, project, busy, run, reload } = ws,
    owner = ws.role === "owner";
  return (
    <>
      <h2>项目成员</h2>
      {owner && (
        <>
          <select
            aria-label="邀请角色"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as Role)}
          >
            <option value="editor">编辑者</option>
            <option value="commenter">批注者</option>
            <option value="viewer">只读</option>
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setInviteLink((await api<Invite>(`${prefix}/invite`, { role: inviteRole })).url);
              })
            }
          >
            生成 7 天有效的单次邀请
          </button>
          {inviteLink && (
            <label>
              邀请链接
              <input readOnly aria-label="邀请链接" value={inviteLink} />
              <button type="button" onClick={() => void navigator.clipboard.writeText(inviteLink)}>
                复制链接
              </button>
            </label>
          )}
        </>
      )}
      {members.map((m) => (
        <div className="member row" key={m.id}>
          <span>{m.username}</span>
          {owner ? (
            <select
              aria-label={`${m.username} 的角色`}
              value={m.role}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value;
                run(async () => {
                  await api(`${prefix}/members/${m.id}`, { role: next }, "PATCH");
                  await reload();
                });
              }}
            >
              {Object.entries(roleName).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted">{roleName[m.role]}</span>
          )}
          {owner && m.id !== ws.user.id && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirm(`撤销 ${m.username} 的访问权限？`))
                  run(async () => {
                    await api(`${prefix}/members/${m.id}`, {}, "DELETE");
                    await reload();
                  });
              }}
            >
              移除
            </button>
          )}
        </div>
      ))}
      {owner && (
        <details className="project-settings">
          <summary>项目设置</summary>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const next = new FormData(e.currentTarget).get("name");
              run(async () => {
                await api(prefix, { name: next }, "PATCH");
                ws.notify("项目已改名，返回列表后可见。");
              });
            }}
          >
            <input aria-label="项目名" name="name" defaultValue={project.name} required />
            <button type="submit" disabled={busy}>
              改名
            </button>
          </form>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              const typed = prompt(
                `删除后无法恢复，所有文件、批注和版本都会删除。请先导出项目备份。\n输入项目名“${project.name}”确认删除：`,
              );
              if (typed !== null)
                run(async () => {
                  await api(prefix, { confirm: typed }, "DELETE");
                  onDeleted();
                });
            }}
          >
            删除项目
          </button>
        </details>
      )}
    </>
  );
}
