import { useState } from "react";
import type { Invite, Member, Role } from "../../shared/api";
import { api } from "../api";
import { useI18n } from "../i18n";
import { roleKey } from "../labels";
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
  const { t } = useI18n();
  const [inviteRole, setInviteRole] = useState<Role>("editor"),
    [inviteLink, setInviteLink] = useState("");
  const { prefix, project, busy, run, reload } = ws,
    owner = ws.role === "owner";
  return (
    <>
      <h2>{t("members.title")}</h2>
      {owner && (
        <>
          <select
            aria-label={t("members.inviteRole")}
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as Role)}
          >
            <option value="editor">{t("role.editor")}</option>
            <option value="commenter">{t("role.commenter")}</option>
            <option value="viewer">{t("role.viewer")}</option>
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
            {t("members.invite")}
          </button>
          {inviteLink && (
            <label>
              {t("members.inviteLink")}
              <input readOnly aria-label={t("members.inviteLink")} value={inviteLink} />
              <button type="button" onClick={() => void navigator.clipboard.writeText(inviteLink)}>
                {t("members.copyLink")}
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
              aria-label={t("members.roleOf", { name: m.username })}
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
              {Object.entries(roleKey).map(([value, key]) => (
                <option key={value} value={value}>
                  {t(key)}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted">{t(roleKey[m.role])}</span>
          )}
          {owner && m.id !== ws.user.id && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirm(t("members.removeConfirm", { name: m.username })))
                  run(async () => {
                    await api(`${prefix}/members/${m.id}`, {}, "DELETE");
                    await reload();
                  });
              }}
            >
              {t("members.remove")}
            </button>
          )}
        </div>
      ))}
      {owner && (
        <details className="project-settings">
          <summary>{t("members.settings")}</summary>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const next = new FormData(e.currentTarget).get("name");
              run(async () => {
                await api(prefix, { name: next }, "PATCH");
                ws.notify(t("members.renamed"));
              });
            }}
          >
            <input
              aria-label={t("members.name")}
              name="name"
              defaultValue={project.name}
              required
            />
            <button type="submit" disabled={busy}>
              {t("members.rename")}
            </button>
          </form>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              const typed = prompt(t("members.deletePrompt", { name: project.name }));
              if (typed !== null)
                run(async () => {
                  await api(prefix, { confirm: typed }, "DELETE");
                  onDeleted();
                });
            }}
          >
            {t("members.delete")}
          </button>
        </details>
      )}
    </>
  );
}
