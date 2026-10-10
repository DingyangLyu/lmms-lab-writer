/** Members, invitations and project settings, opened from the header's Share button. */
import { useEffect, useState } from "react";
import type { Friends, Invite, Member, Person, Role } from "../../shared/api";
import { api } from "../api";
import { Avatar } from "../avatar";
import { copyText } from "../clipboard";
import { useI18n } from "../i18n";
import { roleKey } from "../labels";
import type { WorkspaceContext } from "./context";
import { Btn, Dialog, Input, Select } from "./ui";

export function ShareDialog({
  ws,
  members,
  onClose,
  onDeleted,
}: {
  ws: WorkspaceContext;
  members: Member[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [inviteRole, setInviteRole] = useState<Role>("editor"),
    [inviteLink, setInviteLink] = useState("");
  const { prefix, project, busy, run, reload } = ws,
    owner = ws.role === "owner";
  const [friends, setFriends] = useState<Person[] | null>(null),
    [friendRoles, setFriendRoles] = useState<Record<string, Role>>({});
  useEffect(() => {
    if (owner)
      void api<Friends>("/friends")
        .then((f) => setFriends(f.friends))
        .catch(() => setFriends([]));
  }, [owner]);
  const addable = (friends ?? []).filter((f) => !members.some((m) => m.id === f.id));
  return (
    <Dialog title={t("members.title")} onClose={onClose}>
      <div className="space-y-4">
        {owner && (
          <section className="space-y-2">
            <h3 className="font-medium">{t("share.friends")}</h3>
            <p className="text-xs text-muted">{t("share.friendsLead")}</p>
            {friends && !addable.length ? (
              <p className="text-xs text-muted">{t("share.noFriends")}</p>
            ) : (
              <ul className="border border-border">
                {addable.map((f) => (
                  <li
                    key={f.id}
                    className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-b-0"
                  >
                    <Avatar person={{ id: f.id, name: f.username, avatar: f.avatar }} size={24} />
                    <span className="min-w-0 flex-1 truncate">{f.username}</span>
                    <Select
                      aria-label={t("members.roleOf", { name: f.username })}
                      value={friendRoles[f.id] ?? "editor"}
                      onChange={(e) =>
                        setFriendRoles((roles) => ({ ...roles, [f.id]: e.target.value as Role }))
                      }
                    >
                      <option value="editor">{t("role.editor")}</option>
                      <option value="commenter">{t("role.commenter")}</option>
                      <option value="viewer">{t("role.viewer")}</option>
                    </Select>
                    <Btn
                      tone="solid"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await api(`${prefix}/members`, {
                            user: f.id,
                            role: friendRoles[f.id] ?? "editor",
                          });
                          await reload();
                        })
                      }
                    >
                      {t("share.addFriend")}
                    </Btn>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {owner && (
          <section className="space-y-2">
            <h3 className="font-medium">{t("shell.inviteHeading")}</h3>
            <div className="flex flex-wrap gap-2">
              <Select
                aria-label={t("members.inviteRole")}
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as Role)}
              >
                <option value="editor">{t("role.editor")}</option>
                <option value="commenter">{t("role.commenter")}</option>
                <option value="viewer">{t("role.viewer")}</option>
              </Select>
              <Btn
                tone="solid"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setInviteLink(
                      (await api<Invite>(`${prefix}/invite`, { role: inviteRole })).url,
                    );
                  })
                }
              >
                {t("members.invite")}
              </Btn>
            </div>
            {inviteLink && (
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label={t("members.inviteLink")}
                  value={inviteLink}
                  className="min-w-0 flex-1"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Btn onClick={() => void copyText(inviteLink)}>{t("members.copyLink")}</Btn>
              </div>
            )}
          </section>
        )}
        <section>
          <h3 className="mb-2 font-medium">
            {t("shell.membersHeading", { count: members.length })}
          </h3>
          <ul className="border border-border">
            {members.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-b-0"
              >
                <Avatar person={{ id: m.id, name: m.username, avatar: m.avatar }} size={24} />
                <span className="min-w-0 flex-1 truncate">
                  {m.username}
                  {m.id === ws.user.id && <span className="text-muted"> · {t("shell.you")}</span>}
                </span>
                {owner ? (
                  <Select
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
                  </Select>
                ) : (
                  <span className="text-muted">{t(roleKey[m.role])}</span>
                )}
                {owner && m.id !== ws.user.id && (
                  <Btn
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
                  </Btn>
                )}
              </li>
            ))}
          </ul>
        </section>
        {owner && (
          <section className="space-y-2 border-t border-border pt-3">
            <h3 className="font-medium">{t("members.settings")}</h3>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const next = new FormData(e.currentTarget).get("name");
                run(async () => {
                  await api(prefix, { name: next }, "PATCH");
                  ws.notify(t("members.renamed"));
                });
              }}
            >
              <Input
                aria-label={t("members.name")}
                name="name"
                defaultValue={project.name}
                required
                className="min-w-0 flex-1"
              />
              <Btn type="submit" disabled={busy}>
                {t("members.rename")}
              </Btn>
            </form>
            <Btn
              tone="danger"
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
            </Btn>
          </section>
        )}
      </div>
    </Dialog>
  );
}
