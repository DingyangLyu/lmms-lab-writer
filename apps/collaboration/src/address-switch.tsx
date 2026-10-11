/**
 * The server's other addresses (WRITER_ADDRESSES), for visitors to pick the one nearest them:
 * a lab server can be ten milliseconds away on campus and two seconds away through a domain
 * abroad. Each address keeps its own sign-in, so the switch sits where visitors arrive.
 */
import { CaretDownIcon, CheckIcon, GlobeSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ServerAddress } from "../shared/api";
import { api } from "./api";
import { type MessageKey, useI18n } from "./i18n";

let loading: Promise<ServerAddress[]> | null = null;
const loadAddresses = () => {
  loading ??= api<ServerAddress[]>("/addresses").catch(() => []);
  return loading;
};
const KNOWN = ["campus", "china", "global"];

export function AddressSwitch({ dark = false }: { dark?: boolean }) {
  const { t } = useI18n();
  const [addresses, setAddresses] = useState<ServerAddress[]>([]),
    [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void loadAddresses().then((list) => {
      if (live) setAddresses(list);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !box.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (addresses.length < 2) return null;
  const known = (name: string) => KNOWN.includes(name);
  const label = (name: string) => (known(name) ? t(`address.${name}` as MessageKey) : name);
  const current = addresses.find((a) => a.url === location.origin);
  // The same page (a form, an invitation) at the other address.
  const there = (url: string) => `${url}${location.pathname}${location.search}${location.hash}`;
  return (
    <div className={`addr-switch${dark ? " is-dark" : ""}`} ref={box}>
      <button
        type="button"
        className="addr-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("address.title")}
        onClick={() => setOpen((v) => !v)}
      >
        <GlobeSimpleIcon aria-hidden="true" />
        <span>{current ? label(current.name) : t("address.label")}</span>
        <CaretDownIcon aria-hidden="true" className="addr-caret" />
      </button>
      {open && (
        <div className="addr-menu" role="menu" aria-label={t("address.title")}>
          <div className="addr-head">{t("address.title")}</div>
          {addresses.map((a) => {
            const here = a === current;
            return (
              <a
                key={a.url}
                href={there(a.url)}
                role="menuitemradio"
                aria-checked={here}
                className={here ? "is-current" : undefined}
                onClick={(event) => {
                  if (here) {
                    event.preventDefault();
                    setOpen(false);
                  }
                }}
              >
                <span className="addr-row">
                  <strong>{label(a.name)}</strong>
                  <span className="addr-host">{new URL(a.url).host}</span>
                </span>
                {known(a.name) && (
                  <span className="addr-hint">{t(`address.${a.name}.hint` as MessageKey)}</span>
                )}
                {here && <CheckIcon className="addr-check" weight="bold" aria-hidden="true" />}
              </a>
            );
          })}
          <div className="addr-note">{t("address.note")}</div>
        </div>
      )}
    </div>
  );
}
