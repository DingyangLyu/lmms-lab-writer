/**
 * Which AI conversation work from the page goes to (comments to address, a build to fix): the
 * one in front of the AI panel, another open one, or a new conversation of a chosen kind, as
 * in the desktop's comment manager. The choice is remembered per project in this browser.
 */
import {
  type ConversationTarget,
  HARNESSES,
  type HarnessId,
  isHarnessId,
} from "@lmms-lab/workbench/agents";
import { RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";

/** An open conversation of the AI panel, as the page lists it. */
export type AiConversation = { id: string; backend: HarnessId; title: string };
/** The AI panel's open conversations, the kinds the runner offers, and the one in front. */
export type AiConversations = {
  tabs: AiConversation[];
  harnesses: HarnessId[];
  active: string | null;
};
export const NO_CONVERSATIONS: AiConversations = { tabs: [], harnesses: [], active: null };

/** "front", an open conversation's tab, or "new:<kind>". */
export type AiChoice = string;
const label = (id: HarnessId) => HARNESSES.find((h) => h.id === id)?.label ?? id;

/** Where the work goes; undefined is the conversation in front (or a new one if none). */
export function resolveChoice(
  choice: AiChoice,
  known: AiConversations,
): ConversationTarget | undefined {
  const tab = known.tabs.find((t) => t.id === choice);
  if (tab) return { backend: tab.backend, tabId: tab.id };
  const kind = choice.startsWith("new:") ? choice.slice(4) : null;
  return isHarnessId(kind) ? { backend: kind } : undefined;
}

export function useAiChoice(project: string) {
  const key = `writer-ai-target:${project}`;
  const [choice, setChoice] = useState<AiChoice>(() => {
    try {
      return localStorage.getItem(key) || "front";
    } catch {
      return "front";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, choice);
    } catch {
      /* Remembered for this visit only. */
    }
  }, [key, choice]);
  return [choice, setChoice] as const;
}

/** How a choice reads, e.g. in "sent to Codex · Literature check". */
export function choiceLabel(
  choice: AiChoice,
  known: AiConversations,
  t: ReturnType<typeof useI18n>["t"],
) {
  const tab =
    known.tabs.find((x) => x.id === choice) ??
    (choice === "front" ? known.tabs.find((x) => x.id === known.active) : undefined);
  if (tab) return `${label(tab.backend)} · ${tab.title || t("ai.untitled")}`;
  const kind = choice.startsWith("new:") ? choice.slice(4) : null;
  return isHarnessId(kind) ? t("ai.newConversation", { name: label(kind) }) : t("ai.front");
}

export function AiTargetSelect({
  value,
  onChange,
  conversations,
  className = "",
}: {
  value: AiChoice;
  onChange: (choice: AiChoice) => void;
  conversations: AiConversations;
  className?: string;
}) {
  const { t } = useI18n();
  const kinds = conversations.harnesses.length
    ? conversations.harnesses
    : HARNESSES.map((h) => h.id).filter((id) => id === "codex");
  // A conversation closed since it was chosen falls back to the one in front.
  const known =
    value === "front" ||
    conversations.tabs.some((x) => x.id === value) ||
    (value.startsWith("new:") && kinds.includes(value.slice(4) as HarnessId));
  return (
    <label className={`flex min-w-0 items-center gap-1 ${className}`} title={t("ai.targetTitle")}>
      <RobotIcon className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      <select
        aria-label={t("ai.target")}
        value={known ? value : "front"}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 min-w-0 flex-1 truncate border border-border bg-background px-1 text-xs"
      >
        <option value="front">{t("ai.front")}</option>
        {conversations.tabs.length > 0 && (
          <optgroup label={t("ai.open")}>
            {conversations.tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {label(tab.backend)} · {tab.title || t("ai.untitled")}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label={t("ai.new")}>
          {kinds.map((kind) => (
            <option key={kind} value={`new:${kind}`}>
              {t("ai.newConversation", { name: label(kind) })}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}
