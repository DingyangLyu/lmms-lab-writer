import { useI18n } from "./i18n";

export function LanguageSwitch() {
  const { t, locale, setLocale } = useI18n();
  return (
    <select
      aria-label={t("language.label")}
      className="language-switch"
      value={locale}
      onChange={(e) => setLocale(e.target.value === "en" ? "en" : "zh")}
    >
      <option value="zh">中文</option>
      <option value="en">English</option>
    </select>
  );
}
