/**
 * The bar above every page but the editor, after Overleaf's: the logo, the main pages, the
 * language, and the account menu with friend requests waiting.
 */
import { CaretDownIcon, GearSixIcon, SignOutIcon, UserCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { Friends, PublicUser } from "../shared/api";
import { api } from "./api";
import { Avatar } from "./avatar";
import { useI18n } from "./i18n";
import { LanguageSwitch } from "./language-switch";

export type Page = "projects" | "templates" | "admin" | "profile";

export function TopNav({
  user,
  page,
  onNavigate,
  onSignOut,
}: {
  user: PublicUser;
  page: Page;
  onNavigate: (page: Page) => void;
  onSignOut: () => void;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState(false),
    [requests, setRequests] = useState(0),
    [pending, setPending] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  // Counts are refreshed whenever the member moves between pages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: page changes are the refresh signal.
  useEffect(() => {
    void api<Friends>("/friends")
      .then((f) => setRequests(f.incoming.length))
      .catch(() => {});
    if (user.admin)
      void api<{ pending: number }>("/admin/summary")
        .then((s) => setPending(s.pending))
        .catch(() => {});
  }, [page, user.admin]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const link = (target: Page, label: string, count = 0) => (
    <button
      type="button"
      className={`nav-link ${page === target ? "current" : ""}`}
      aria-current={page === target ? "page" : undefined}
      onClick={() => onNavigate(target)}
    >
      {label}
      {count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );
  return (
    <header className="top-nav">
      <button type="button" className="nav-brand" onClick={() => onNavigate("projects")}>
        <img src="/logo-light.svg" alt="Y-Writer" />
      </button>
      <nav aria-label={t("nav.label")}>
        {link("projects", t("nav.projects"))}
        {link("templates", t("nav.templates"))}
        {user.admin && link("admin", t("nav.admin"), pending)}
      </nav>
      <div className="nav-end">
        <LanguageSwitch />
        <div className="nav-account" ref={menuRef}>
          <button
            type="button"
            className="nav-account-button"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
          >
            <Avatar person={user} size={30} />
            <span className="nav-name">{user.name}</span>
            {requests > 0 && (
              <span className="nav-dot" title={t("nav.requests", { count: requests })} />
            )}
            <CaretDownIcon aria-hidden="true" />
          </button>
          {menu && (
            <div className="nav-menu" role="menu">
              <div className="nav-menu-head">
                <Avatar person={user} size={40} />
                <div>
                  <strong>{user.name}</strong>
                  <span className="nav-menu-role">
                    {user.admin ? t("nav.roleAdmin") : t("nav.roleMember")}
                  </span>
                </div>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  onNavigate("profile");
                }}
              >
                <UserCircleIcon aria-hidden="true" />
                {t("nav.profile")}
                {requests > 0 && <span className="nav-count">{requests}</span>}
              </button>
              {user.admin && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onNavigate("admin");
                  }}
                >
                  <GearSixIcon aria-hidden="true" />
                  {t("nav.admin")}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  onSignOut();
                }}
              >
                <SignOutIcon aria-hidden="true" />
                {t("projects.signOut")}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
