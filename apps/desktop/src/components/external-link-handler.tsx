"use client";

import { isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";

/**
 * Intercepts external links and opens them in system browser instead of WebView.
 * Required because Tauri WebView lacks cookies/sessions for OAuth flows.
 */
export function ExternalLinkHandler() {
  useEffect(() => {
    if (!isTauri()) return;
    const handleClick = async (e: MouseEvent) => {
      const anchor = e.target instanceof Element ? e.target.closest("a") : null;

      if (!anchor || anchor.hasAttribute("data-writer-link")) return;

      const href = anchor.getAttribute("href");
      if (!href) return;

      const isExternal = href.startsWith("http://") || href.startsWith("https://");
      let isSameOrigin = false;
      try {
        isSameOrigin = isExternal && new URL(href).origin === window.location.origin;
      } catch {
        isSameOrigin = false;
      }

      if (isExternal && !isSameOrigin) {
        e.preventDefault();
        e.stopPropagation();

        try {
          const { open } = await import("@tauri-apps/plugin-shell");
          await open(href);
        } catch (err) {
          console.error("Failed to open external link:", err);
          originalWindowOpen.call(window, href, "_blank", "noopener,noreferrer");
        }
      }
    };

    const originalWindowOpen = window.open;
    window.open = (url?: string | URL, target?: string, features?: string) => {
      const urlString = url?.toString() ?? "";
      const isExternal = urlString.startsWith("http://") || urlString.startsWith("https://");
      let isSameOrigin = false;
      try {
        isSameOrigin = isExternal && new URL(urlString).origin === window.location.origin;
      } catch {
        isSameOrigin = false;
      }

      if (isExternal && !isSameOrigin) {
        import("@tauri-apps/plugin-shell").then(({ open }) => open(urlString)).catch(console.error);
        return null;
      }

      return originalWindowOpen.call(window, url, target, features);
    };

    document.addEventListener("click", handleClick, true);

    return () => {
      document.removeEventListener("click", handleClick, true);
      window.open = originalWindowOpen;
    };
  }, []);

  return null;
}
