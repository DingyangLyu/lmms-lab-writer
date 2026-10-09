import { useState } from "react";
import { api, errorText } from "./api";
import { useI18n } from "./i18n";

export function ChangePassword({
  forced,
  onDone,
  onCancel,
}: {
  forced?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
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
          setError(t("account.mismatch"));
          return;
        }
        setBusy(true);
        setError("");
        void api("/me/password", { current, next })
          .then(onDone)
          .catch((e) => setError(errorText(e)))
          .finally(() => setBusy(false));
      }}
    >
      <h2>{forced ? t("account.forcedTitle") : t("account.title")}</h2>
      {forced && <p className="muted">{t("account.forcedLead")}</p>}
      <label>
        {forced ? t("account.temporary") : t("account.current")}
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </label>
      <label>
        {t("account.new")}
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
        {t("account.repeat")}
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
          {busy ? t("account.saving") : t("account.save")}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        )}
      </div>
      <p className="muted">{t("account.signOutOthers")}</p>
    </form>
  );
}
