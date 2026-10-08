"use client";
import Image from "next/image";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { imageSource } from "@/lib/chat/images";
import { i18n, useI18n } from "@/lib/i18n";

export const ChatImageDirectory = createContext<string | undefined>(undefined);

export function ChatImage({
  url,
  name = i18n.t("chat.image"),
  directory,
}: {
  url: string;
  name?: string;
  directory?: string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const project = useContext(ChatImageDirectory);
  const src = imageSource(url, directory ?? project);
  useEffect(() => {
    if (!expanded) return;
    const prior = document.activeElement;
    closeRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      if (prior instanceof HTMLElement) prior.focus();
    };
  }, [expanded]);
  if (!src)
    return (
      <span className="text-xs text-muted">{t("chat.imagePathUnavailableName", { name })}</span>
    );
  return (
    <>
      <button
        type="button"
        className="inline-flex max-w-full cursor-zoom-in border border-border bg-background p-1 hover:border-accent"
        title={t("chat.viewImageName", { name })}
        onClick={() => setExpanded(true)}
      >
        {failedUrl === src ? (
          <span className="p-2 text-xs text-muted">
            {t("chat.theImageCouldNotBeLoadedName", { name })}
          </span>
        ) : (
          <Image
            unoptimized
            style={{ width: "auto", height: "auto" }}
            src={src}
            alt={name}
            width={160}
            height={112}
            onError={() => setFailedUrl(src)}
            className="max-h-28 w-auto max-w-full object-contain"
          />
        )}
      </button>
      {expanded &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={name}
            className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3 bg-black/85 p-8"
          >
            <button
              type="button"
              ref={closeRef}
              onClick={() => setExpanded(false)}
              className="absolute right-5 top-5 border border-white/50 bg-black px-3 py-2 text-white"
            >
              {t("chat.closeEsc")}
            </button>
            <Image
              unoptimized
              style={{ width: "auto", height: "auto" }}
              src={src}
              alt={name}
              width={1600}
              height={1200}
              className="max-h-[82vh] w-auto max-w-[92vw] object-contain"
            />
            <span className="max-w-full truncate text-sm text-white">{name}</span>
          </div>,
          document.body,
        )}
    </>
  );
}
