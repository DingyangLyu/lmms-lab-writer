/**
 * What only a shared runner reports: what reached the shared project from the agent's last
 * step, and another member's AI turn that is changing the project right now.
 */
import { useWorkbenchI18n } from "../../i18n";

export type ChangeResult = { path: string; status: string; reason?: string };

export function changeSummary(
  results: ChangeResult[],
  t: ReturnType<typeof useWorkbenchI18n>["t"],
) {
  const applied = results.filter((r) => r.status === "applied").length,
    proposals = results.filter((r) => r.status === "proposal"),
    skipped = results.filter((r) => r.status === "skipped");
  return [
    applied ? t("codex.countFilesUpdatedInTheSharedProject", { count: applied }) : "",
    proposals.length
      ? t("codex.overlapsWithCollaboratorsKeptAsSuggestionsPaths", {
          paths: proposals.map((r) => r.path).join(", "),
        })
      : "",
    ...skipped.map((r) => `${r.path}: ${r.reason ?? ""}`),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SharedRunnerNotice({
  notice,
  busyName,
}: {
  notice: string | null;
  busyName: string | null;
}) {
  const { t } = useWorkbenchI18n();
  if (!notice && !busyName) return null;
  return (
    <div role="status" className="border-t border-border px-3 py-2 text-xs text-muted">
      {busyName && <p>{t("codex.nameSAiConversationIsChangingTheProject", { name: busyName })}</p>}
      {notice && <p>{notice}</p>}
    </div>
  );
}
