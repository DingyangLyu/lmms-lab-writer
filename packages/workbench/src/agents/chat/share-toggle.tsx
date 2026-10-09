/**
 * Private / shared switch for a conversation on the shared runner, shown to the member who
 * started it; others see whose conversation it is.
 */
import { useState } from "react";
import { useWorkbenchI18n } from "../../i18n";

export function ShareToggle({
  mine,
  shared,
  ownerName,
  onShare,
  onError,
}: {
  mine?: boolean;
  shared?: boolean;
  ownerName?: string;
  onShare: (shared: boolean) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const { t } = useWorkbenchI18n();
  const [saving, setSaving] = useState(false);
  if (mine === false)
    return (
      <span className="max-w-32 truncate text-xs text-muted">
        {t("codex.sharedByName", { name: ownerName ?? "" })}
      </span>
    );
  if (!mine) return null;
  return (
    <button
      type="button"
      aria-pressed={!!shared}
      disabled={saving}
      onClick={() => {
        setSaving(true);
        onShare(!shared)
          .catch((cause) => onError(String(cause)))
          .finally(() => setSaving(false));
      }}
      className={`shrink-0 whitespace-nowrap border px-2 py-1 text-xs disabled:opacity-50 ${shared ? "border-accent text-accent" : "border-border hover:bg-accent-hover"}`}
      title={
        shared
          ? t("harness.sharedWithTheProjectClickToMakeItPrivate")
          : t("harness.onlyYouCanSeeThisConversationClickToShar")
      }
    >
      {shared ? t("harness.shared") : t("harness.private")}
    </button>
  );
}
