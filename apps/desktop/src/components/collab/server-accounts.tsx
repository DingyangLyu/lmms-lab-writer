"use client";
import { useCallback, useEffect, useState } from "react";
import { type CollabAccount, listAccounts, signIn, signOut } from "@/lib/collab/accounts";
import { useI18n } from "@/lib/i18n";

const LAST_SERVER = "writer-collaboration-url";

/** Collaboration servers this computer is signed in to, and the sign-in form. */
export function ServerAccounts({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<CollabAccount[]>([]);
  const [server, setServer] = useState(() => {
    try {
      return localStorage.getItem(LAST_SERVER) || "https://";
    } catch {
      return "https://";
    }
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(
    () =>
      listAccounts()
        .then(setAccounts)
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    void action()
      .then(async () => {
        await reload();
        onChanged?.();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground leading-6">{t("collab.accounts.intro")}</p>
      {accounts.length ? (
        <ul className="space-y-2">
          {accounts.map((account) => (
            <li
              key={account.server}
              className="flex items-center justify-between gap-3 border border-border p-3"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{account.server}</p>
                <p className="text-xs text-muted-foreground">
                  {t("collab.accounts.signedIn", { name: account.user.name })}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                className="border border-border px-3 py-1.5 text-xs hover:border-foreground disabled:opacity-50"
                onClick={() => run(() => signOut(account.server))}
              >
                {t("collab.accounts.signOut")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("collab.accounts.none")}</p>
      )}
      <form
        className="space-y-2 border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            const account = await signIn(server, username, password);
            setPassword("");
            try {
              localStorage.setItem(LAST_SERVER, account.server);
            } catch {
              // Only the prefilled address is lost.
            }
          });
        }}
      >
        <label className="block text-xs">
          {t("collab.accounts.server")}
          <input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            className="mt-1 w-full border border-border bg-background p-2 font-mono text-sm"
            placeholder="https://writer.example.com"
            required
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">
            {t("collab.accounts.username")}
            <input
              value={username}
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full border border-border bg-background p-2 text-sm"
              required
            />
          </label>
          <label className="block text-xs">
            {t("collab.accounts.password")}
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full border border-border bg-background p-2 text-sm"
              required
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">{t("collab.accounts.httpsHint")}</p>
        {error && (
          <p role="alert" className="text-xs text-red-600 break-words">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="border-2 border-foreground px-4 py-1.5 text-sm disabled:opacity-50"
        >
          {busy ? t("collab.accounts.signingIn") : t("collab.accounts.signIn")}
        </button>
      </form>
    </div>
  );
}
