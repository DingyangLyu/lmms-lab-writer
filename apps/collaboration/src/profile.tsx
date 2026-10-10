/** The member's own page: their picture, their friends and requests, and their password. */
import { MagnifyingGlassIcon, UploadSimpleIcon, UserPlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { FoundUser, Friends, Person, PublicUser } from "../shared/api";
import { ChangePassword } from "./account";
import { api, errorText } from "./api";
import { Avatar } from "./avatar";
import { i18n, useI18n } from "./i18n";
import { useAction } from "./use-action";

/** The picture as the server keeps it: the centre square, 256 px. */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(i18n.t("profile.imageFailed"));
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    256,
    256,
  );
  bitmap.close();
  return new Promise((resolve, reject) =>
    // Browsers without WebP encoding give PNG, which the server takes as well.
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(i18n.t("profile.imageFailed")))),
      "image/webp",
      0.9,
    ),
  );
}
async function uploadAvatar(blob: Blob) {
  const response = await fetch("/api/me/avatar", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": blob.type || "image/png", "X-Writer-Locale": i18n.getLocale() },
    body: blob,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || i18n.t("common.requestFailed", { status: response.status }));
  return data.avatar as number;
}
const pictured = (p: Person) => ({ id: p.id, name: p.username, avatar: p.avatar });

export function ProfilePage({
  user,
  onUser,
}: {
  user: PublicUser;
  /** The signed-in user after a change, such as a new picture. */
  onUser: (user: PublicUser) => void;
}) {
  const { t } = useI18n();
  const picture = useAction();
  const [passwordSaved, setPasswordSaved] = useState(false);
  return (
    <main className="page">
      <div className="page-head">
        <h1>{t("profile.title")}</h1>
        <p className="muted">{t("profile.lead")}</p>
      </div>
      <section className="panel">
        <h2>{t("profile.picture")}</h2>
        <div className="profile-picture">
          <Avatar person={user} size={88} />
          <div>
            <strong className="profile-name">{user.name}</strong>
            <p className="muted">{t("profile.pictureHint")}</p>
            <div className="row">
              <label className="button-like primary">
                <UploadSimpleIcon aria-hidden="true" />
                {picture.busy ? t("common.working") : t("profile.upload")}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  disabled={picture.busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file)
                      picture.run(async () =>
                        onUser({ ...user, avatar: await uploadAvatar(await shrink(file)) }),
                      );
                  }}
                />
              </label>
              {user.avatar && (
                <button
                  type="button"
                  disabled={picture.busy}
                  onClick={() =>
                    picture.run(async () => {
                      await api("/me/avatar", {}, "DELETE");
                      onUser({ ...user, avatar: null });
                    })
                  }
                >
                  {t("profile.remove")}
                </button>
              )}
            </div>
            {picture.error && (
              <p role="alert" className="error">
                {picture.error}
              </p>
            )}
          </div>
        </div>
      </section>
      <FriendsPanel />
      <section className="panel">
        <ChangePassword onDone={() => setPasswordSaved(true)} />
        {passwordSaved && <p className="notice-inline">{t("profile.passwordSaved")}</p>}
      </section>
    </main>
  );
}

function FriendsPanel() {
  const { t } = useI18n();
  const [friends, setFriends] = useState<Friends | null>(null),
    [query, setQuery] = useState(""),
    [found, setFound] = useState<FoundUser[]>([]);
  const { busy, error, setError, run } = useAction();
  useEffect(() => {
    void api<Friends>("/friends")
      .then(setFriends)
      .catch((e) => setError(errorText(e)));
  }, [setError]);
  const search = useCallback(
    (q: string) =>
      api<FoundUser[]>(`/users/search?q=${encodeURIComponent(q)}`)
        .then(setFound)
        .catch((e) => setError(errorText(e))),
    [setError],
  );
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => void search(q), 250);
    return () => clearTimeout(timer);
  }, [query, search]);
  /** Every change returns the new lists; the search results follow. */
  const change = (request: () => Promise<Friends>) =>
    run(async () => {
      setFriends(await request());
      if (query.trim()) await search(query.trim());
    });
  const add = (username: string) => change(() => api<Friends>("/friends", { username }));
  const accept = (p: Person) => change(() => api<Friends>(`/friends/${p.id}/accept`, {}));
  const drop = (p: Person) => change(() => api<Friends>(`/friends/${p.id}`, {}, "DELETE"));
  const row = (p: Person, actions: React.ReactNode) => (
    <li key={p.id} className="person-row">
      <Avatar person={pictured(p)} size={32} />
      <span className="person-name">{p.username}</span>
      <span className="row">{actions}</span>
    </li>
  );
  return (
    <section className="panel">
      <h2>{t("friends.title")}</h2>
      <p className="muted">{t("friends.lead")}</p>
      <label className="search-field">
        <MagnifyingGlassIcon aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={t("friends.search")}
          aria-label={t("friends.search")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {query.trim() && (
        <ul className="people">
          {!found.length && <li className="muted">{t("friends.noMatch")}</li>}
          {found.map((p) =>
            row(
              p,
              p.relation === "friend" ? (
                <span className="muted">{t("friends.already")}</span>
              ) : p.relation === "outgoing" ? (
                <span className="muted">{t("friends.sent")}</span>
              ) : p.relation === "incoming" ? (
                <button type="button" className="primary" disabled={busy} onClick={() => accept(p)}>
                  {t("friends.accept")}
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => add(p.username)}
                >
                  <UserPlusIcon aria-hidden="true" />
                  {t("friends.add")}
                </button>
              ),
            ),
          )}
        </ul>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!!friends?.incoming.length && (
        <>
          <h3>{t("friends.incoming", { count: friends.incoming.length })}</h3>
          <ul className="people">
            {friends.incoming.map((p) =>
              row(
                p,
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => accept(p)}
                  >
                    {t("friends.accept")}
                  </button>
                  <button type="button" disabled={busy} onClick={() => drop(p)}>
                    {t("friends.decline")}
                  </button>
                </>,
              ),
            )}
          </ul>
        </>
      )}
      <h3>{t("friends.mine", { count: friends?.friends.length ?? 0 })}</h3>
      <ul className="people">
        {friends && !friends.friends.length && <li className="muted">{t("friends.none")}</li>}
        {friends?.friends.map((p) =>
          row(
            p,
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirm(t("friends.removeConfirm", { name: p.username }))) drop(p);
              }}
            >
              {t("friends.remove")}
            </button>,
          ),
        )}
      </ul>
      {!!friends?.outgoing.length && (
        <>
          <h3>{t("friends.outgoing", { count: friends.outgoing.length })}</h3>
          <ul className="people">
            {friends.outgoing.map((p) =>
              row(
                p,
                <button type="button" disabled={busy} onClick={() => drop(p)}>
                  {t("friends.withdraw")}
                </button>,
              ),
            )}
          </ul>
        </>
      )}
    </section>
  );
}
