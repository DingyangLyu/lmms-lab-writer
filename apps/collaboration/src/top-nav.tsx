/**
 * The bar above every page but the editor, after Overleaf's: the logo, the main pages, the
 * language, messages (mentions and replies in comments), and the account menu with friend
 * requests waiting.
 */
import {
  BellIcon,
  CaretDownIcon,
  GearSixIcon,
  SignOutIcon,
  UserCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { Friends, Notice, PublicUser } from "../shared/api";
import { api } from "./api";
import { Avatar } from "./avatar";
import { useI18n } from "./i18n";
import { InboxList, useInbox } from "./inbox";
import { LanguageSwitch } from "./language-switch";

/** The bell with the unread count, and the messages under it. */
function Messages({ onOpen }: { onOpen: (notice: Notice) => void }) {
  const { t } = useI18n();
  const { inbox, markRead } = useInbox();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
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
  const unread = inbox?.unread ?? 0;
  return (
    <div className="nav-account" ref={box}>
      <button
        type="button"
        className="nav-bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("inbox.button", { count: unread })}
        title={t("inbox.button", { count: unread })}
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon weight={unread ? "fill" : "regular"} aria-hidden="true" />
        {unread > 0 && <span className="nav-bell-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("inbox.title")}
          className="pop-in absolute top-[calc(100%+8px)] right-0 z-50 flex max-h-[min(70vh,520px)] w-[min(380px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        >
          <div className="border-b border-border px-3 py-2 text-sm font-semibold">
            {t("inbox.title")}
          </div>
          <InboxList
            inbox={inbox}
            onReadAll={() => markRead()}
            onOpen={(notice) => {
              markRead([notice.id]);
              setOpen(false);
              onOpen(notice);
            }}
          />
        </div>
      )}
    </div>
  );
}

export type Page = "projects" | "templates" | "friends" | "desktop" | "admin" | "profile";

export function TopNav({
  user,
  page,
  onNavigate,
  onOpenNotice,
  onSignOut,
}: {
  user: PublicUser;
  page: Page;
  onNavigate: (page: Page) => void;
  onOpenNotice: (notice: Notice) => void;
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
        {link("friends", t("nav.friends"), requests)}
        {link("desktop", t("nav.desktop"))}
        {user.admin && link("admin", t("nav.admin"), pending)}
      </nav>
      <div className="nav-end">
        <LanguageSwitch />
        <Messages onOpen={onOpenNotice} />
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
