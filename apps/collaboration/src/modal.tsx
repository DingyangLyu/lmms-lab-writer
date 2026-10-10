import { XIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect } from "react";
import { useI18n } from "./i18n";

/** A centred dialog over the dashboard or the template gallery; Escape closes it. */
export function Modal({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dash-backdrop">
      <div
        className={`dash-modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label={t("common.close")}>
            <XIcon aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
