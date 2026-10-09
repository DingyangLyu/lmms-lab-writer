import { workbenchI18n as i18n, useWorkbenchI18n as useI18n } from "../../i18n";
import { agentPlatform } from "../platform";
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return i18n.t("opencode.now");
  if (diffMins < 60) return i18n.t("opencode.nM", { n: diffMins });
  if (diffHours < 24) return i18n.t("opencode.nH", { n: diffHours });
  if (diffDays < 7) return i18n.t("opencode.nD", { n: diffDays });
  return date.toLocaleDateString(i18n.getLocale() === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  const json = JSON.stringify(value, null, 2);
  return json.length > 300 ? `${json.slice(0, 300)}...` : json;
}

export function ErrorMessage({ message }: { message: string }) {
  const { t } = useI18n();
  const urlMatch = message.match(/(https?:\/\/[^\s]+)/);
  const url = urlMatch?.[1];

  if (url) {
    const parts = message.split(url);

    const handleClick = () => {
      void agentPlatform().openExternal(url);
    };

    return (
      <>
        {parts[0]}
        <button
          type="button"
          onClick={handleClick}
          className="underline hover:text-red-900 font-medium"
        >
          {url.includes("billing") ? t("opencode.addPaymentMethod") : url}
        </button>
        {parts[1]}
      </>
    );
  }

  return <>{message}</>;
}
