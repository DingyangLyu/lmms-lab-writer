/**
 * Small pieces in the desktop app's style (monochrome, square, `text-xs`) for the web
 * workbench: buttons, fields, the header's toggle buttons, dialogs, status-bar popovers and
 * the drag handles between panels.
 */
import { XIcon } from "@phosphor-icons/react";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";

const join = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");
/** Above everything else on the page; inline where there is no page (server rendering). */
export const onTop = (node: ReactNode) =>
  typeof document === "undefined" ? node : createPortal(node, document.body);

/** The bordered button of the desktop status bar and panels. */
export function Btn({
  className,
  tone = "plain",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "plain" | "solid" | "danger" }) {
  return (
    <button
      type="button"
      {...props}
      className={join(
        "inline-flex shrink-0 items-center justify-center gap-1.5 border px-2 py-1 text-xs transition-colors disabled:opacity-40",
        tone === "solid" && "border-foreground bg-foreground text-background hover:opacity-90",
        tone === "danger" && "border-red-600 text-red-600 hover:bg-red-600 hover:text-white",
        tone === "plain" && "border-border hover:border-foreground hover:bg-accent-hover",
        className,
      )}
    />
  );
}

/** A square icon button of the header that shows whether its panel is open. */
export function ToggleButton({
  pressed,
  label,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      {...props}
      className={join(
        "flex h-8 w-8 shrink-0 items-center justify-center border bg-background text-foreground transition-colors disabled:opacity-40",
        pressed
          ? "border-foreground"
          : "border-border hover:border-border-dark hover:bg-accent-hover",
        className,
      )}
    >
      {children}
    </button>
  );
}

export const fieldClass =
  "border border-border bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none disabled:opacity-50";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={join(fieldClass, className)} />;
}
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={join(fieldClass, "h-8", className)} />;
}
export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={join(fieldClass, "w-full resize-y p-2", className)} />;
}

/** A centred dialog over a dimmed page; Escape and the close button dismiss it. */
export function Dialog({
  title,
  onClose,
  wide,
  children,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return onTop(
    <div className="wb fixed inset-0 z-[175] flex items-center justify-center bg-black/30 p-3 sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className={join(
          "modal-content flex max-h-[90dvh] w-full flex-col border border-border bg-background text-xs shadow-xl",
          wide ? "max-w-6xl" : "max-w-xl",
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <strong className="truncate text-sm">{title}</strong>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="p-1 hover:text-accent"
          >
            <XIcon className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
        {footer && (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-2">
            {footer}
          </footer>
        )}
      </div>
    </div>,
  );
}

/**
 * A panel opened from a header button and placed below it, like the desktop's comment
 * history. Clicking elsewhere or Escape closes it.
 */
export function Popover({
  open,
  onClose,
  anchor,
  label,
  width: widest = 800,
  align = "start",
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  label: string;
  /** At most this wide, and never wider than the window. */
  width?: number;
  /** Which edge lines up with the button: its left ("start") or its right ("end"). */
  align?: "start" | "end";
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 80, width: 720, maxHeight: 500 });
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(widest, window.innerWidth - 24);
      const top = rect.bottom + 6;
      const left = align === "end" ? rect.right - width : rect.left;
      setPosition({
        left: Math.max(12, Math.min(left, window.innerWidth - width - 12)),
        top,
        width,
        maxHeight: Math.max(160, Math.min(640, window.innerHeight - top - 16)),
      });
    };
    place();
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchor, onClose, widest, align]);
  if (!open) return null;
  return onTop(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      style={{ ...position, position: "fixed" }}
      className="wb z-[160] flex flex-col overflow-hidden border border-border bg-background text-xs text-foreground shadow-xl"
    >
      {children}
    </div>,
  );
}

/** The thin drag handle between two panels; reports how far the pointer moved. */
export function ResizeHandle({
  onResize,
  onDone,
  vertical,
  label,
}: {
  onResize: (delta: number) => void;
  onDone?: () => void;
  /** A horizontal bar dragged up and down, for panels above or below each other. */
  vertical?: boolean;
  label: string;
}) {
  const [active, setActive] = useState(false);
  const last = useRef(0);
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    last.current = vertical ? event.clientY : event.clientX;
    setActive(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active) return;
    const now = vertical ? event.clientY : event.clientX;
    onResize(now - last.current);
    last.current = now;
  };
  const up = () => {
    if (!active) return;
    setActive(false);
    onDone?.();
  };
  return (
    // Pointer-only: panels also open and close from the header, so keyboards lose nothing.
    <div
      aria-hidden="true"
      title={label}
      className={join(
        "group relative shrink-0",
        vertical ? "h-1 w-full cursor-row-resize" : "w-1 cursor-col-resize",
      )}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div
        className={join(
          "h-full w-full transition-colors",
          active ? "bg-foreground/20" : "group-hover:bg-foreground/20",
        )}
      />
    </div>
  );
}

/**
 * A size remembered per browser, clamped to a range. `limit` caps it for now (a smaller
 * window) without forgetting the size the member chose.
 */
export function useStoredSize(
  key: string,
  fallback: number,
  min: number,
  max: number,
  limit = max,
) {
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  const [size, setSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      return saved ? clamp(saved) : fallback;
    } catch {
      return fallback;
    }
  });
  const latest = useRef(size);
  latest.current = size;
  return {
    size: Math.max(min, Math.min(size, limit)),
    resize: (delta: number) => setSize((value) => clamp(Math.min(value, limit) + delta)),
    save: () => {
      try {
        localStorage.setItem(key, String(latest.current));
      } catch {
        /* The size lasts for this visit only. */
      }
    },
  };
}
