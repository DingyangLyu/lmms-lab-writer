"use client";

import { TerminalIcon, XIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import dynamic from "next/dynamic";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TerminalShellMode } from "@/lib/editor";
import { pathSync } from "@/lib/path";

const DEFAULT_TERMINAL_HEIGHT = 224;
const MIN_TERMINAL_HEIGHT = 120;
const MAX_TERMINAL_HEIGHT_RATIO = 0.5;
const TERMINAL_HEIGHT_STORAGE_KEY = "terminalHeight";
const RESIZE_STEP = 16;
const LARGE_RESIZE_STEP = 64;

const PANEL_SPRING = {
  type: "spring" as const,
  stiffness: 520,
  damping: 42,
  mass: 0.8,
};

const INSTANT_TRANSITION = { duration: 0 } as const;

const EditorTerminal = dynamic(
  () => import("@/components/editor/terminal").then((mod) => mod.Terminal),
  {
    ssr: false,
    loading: () => (
      <div className="h-full flex items-center px-4 text-sm text-muted">Loading terminal...</div>
    ),
  },
);

type TerminalPanelProps = {
  projectPath: string | null;
  open: boolean;
  shellMode: TerminalShellMode;
  customShell: string;
  prefersReducedMotion: boolean;
  onClose: () => void;
};

function getMaxTerminalHeight(): number {
  if (typeof window === "undefined") {
    return DEFAULT_TERMINAL_HEIGHT;
  }

  return Math.max(MIN_TERMINAL_HEIGHT, Math.floor(window.innerHeight * MAX_TERMINAL_HEIGHT_RATIO));
}

function clampTerminalHeight(height: number): number {
  return Math.min(Math.max(height, MIN_TERMINAL_HEIGHT), getMaxTerminalHeight());
}

function readStoredTerminalHeight(): number {
  if (typeof window === "undefined") {
    return DEFAULT_TERMINAL_HEIGHT;
  }

  const savedHeight = window.localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
  const parsedHeight = savedHeight ? Number.parseInt(savedHeight, 10) : Number.NaN;

  if (!Number.isFinite(parsedHeight)) {
    return DEFAULT_TERMINAL_HEIGHT;
  }

  return clampTerminalHeight(parsedHeight);
}

function getShellLabel(shellMode: TerminalShellMode, customShell: string): string {
  const trimmedShell = customShell.trim();
  if (shellMode !== "custom" || trimmedShell.length === 0) {
    return "auto";
  }

  const shellParts = trimmedShell.replace(/\\/g, "/").split("/").filter(Boolean);
  return shellParts[shellParts.length - 1] ?? trimmedShell;
}

export function TerminalPanel({
  projectPath,
  open,
  shellMode,
  customShell,
  prefersReducedMotion,
  onClose,
}: TerminalPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const heightRef = useRef(DEFAULT_TERMINAL_HEIGHT);
  const frameRef = useRef<number | null>(null);
  const pendingPointerYRef = useRef<number | null>(null);
  const [height, setHeight] = useState(readStoredTerminalHeight);
  const [isResizing, setIsResizing] = useState(false);

  const projectName = useMemo(
    () => (projectPath ? pathSync.basename(projectPath) : ""),
    [projectPath],
  );
  const shellLabel = useMemo(() => getShellLabel(shellMode, customShell), [shellMode, customShell]);
  const shellTitle =
    shellMode === "custom" && customShell.trim().length > 0 ? customShell.trim() : "Auto shell";

  const setPanelHeightVariable = useCallback((nextHeight: number) => {
    panelRef.current?.style.setProperty("--terminal-panel-height", `${nextHeight}px`);
  }, []);

  const commitHeight = useCallback(
    (nextHeight: number) => {
      const clampedHeight = clampTerminalHeight(nextHeight);
      heightRef.current = clampedHeight;
      setHeight(clampedHeight);
      setPanelHeightVariable(clampedHeight);
    },
    [setPanelHeightVariable],
  );

  const applyHeightFromPointer = useCallback(
    (pointerY: number) => {
      const nextHeight = clampTerminalHeight(window.innerHeight - pointerY);
      heightRef.current = nextHeight;
      setPanelHeightVariable(nextHeight);
    },
    [setPanelHeightVariable],
  );

  useEffect(() => {
    heightRef.current = height;
    setPanelHeightVariable(height);
  }, [height, setPanelHeightVariable]);

  useEffect(() => {
    window.localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(height));
  }, [height]);

  useEffect(() => {
    const handleWindowResize = () => {
      const nextHeight = clampTerminalHeight(heightRef.current);
      if (nextHeight !== heightRef.current) {
        commitHeight(nextHeight);
      }
    };

    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [commitHeight]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const handleResizeStart = useCallback(() => {
    setIsResizing(true);
    setPanelHeightVariable(heightRef.current);
  }, [setPanelHeightVariable]);

  const handleResizeDrag = useCallback(
    (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      pendingPointerYRef.current = info.point.y;

      if (frameRef.current !== null) {
        return;
      }

      frameRef.current = window.requestAnimationFrame(() => {
        const pointerY = pendingPointerYRef.current;
        if (pointerY !== null) {
          applyHeightFromPointer(pointerY);
        }
        frameRef.current = null;
      });
    },
    [applyHeightFromPointer],
  );

  const handleResizeEnd = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    const pointerY = pendingPointerYRef.current;
    if (pointerY !== null) {
      applyHeightFromPointer(pointerY);
      pendingPointerYRef.current = null;
    }

    setHeight(heightRef.current);
    setIsResizing(false);
  }, [applyHeightFromPointer]);

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      let nextHeight: number | null = null;

      if (event.key === "ArrowUp") {
        nextHeight = heightRef.current + RESIZE_STEP;
      } else if (event.key === "ArrowDown") {
        nextHeight = heightRef.current - RESIZE_STEP;
      } else if (event.key === "PageUp") {
        nextHeight = heightRef.current + LARGE_RESIZE_STEP;
      } else if (event.key === "PageDown") {
        nextHeight = heightRef.current - LARGE_RESIZE_STEP;
      } else if (event.key === "Home") {
        nextHeight = MIN_TERMINAL_HEIGHT;
      } else if (event.key === "End") {
        nextHeight = getMaxTerminalHeight();
      }

      if (nextHeight === null) {
        return;
      }

      event.preventDefault();
      commitHeight(nextHeight);
    },
    [commitHeight],
  );

  return (
    <AnimatePresence>
      {open && projectPath && (
        <motion.div
          ref={panelRef}
          key="terminal-container"
          initial={prefersReducedMotion ? { opacity: 1, height: 0 } : { opacity: 0, height: 0 }}
          animate={{
            opacity: 1,
            height: isResizing ? "var(--terminal-panel-height)" : height,
          }}
          exit={prefersReducedMotion ? { opacity: 0, height: 0 } : { opacity: 0, height: 0 }}
          transition={prefersReducedMotion ? INSTANT_TRANSITION : PANEL_SPRING}
          className="flex-shrink-0 border-t border-border bg-background flex flex-col overflow-hidden"
          style={
            {
              "--terminal-panel-height": `${height}px`,
              willChange: prefersReducedMotion ? undefined : "height, opacity",
            } as CSSProperties
          }
        >
          <div className="relative group h-1 flex-shrink-0">
            <motion.div
              drag="y"
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={0}
              dragMomentum={false}
              onDragStart={handleResizeStart}
              onDrag={handleResizeDrag}
              onDragEnd={handleResizeEnd}
              onKeyDown={handleResizeKeyDown}
              role="separator"
              aria-label="Resize terminal"
              aria-orientation="horizontal"
              aria-valuemin={MIN_TERMINAL_HEIGHT}
              aria-valuemax={getMaxTerminalHeight()}
              aria-valuenow={height}
              tabIndex={0}
              className="absolute inset-x-0 -top-1 -bottom-1 cursor-row-resize z-20 focus:outline-none focus-visible:bg-foreground/10"
              style={{ y: 0 }}
            />
            <div
              className={`w-full h-full transition-colors ${
                isResizing ? "bg-foreground/20" : "group-hover:bg-foreground/20"
              }`}
            />
          </div>

          <div className="h-8 flex-shrink-0 border-b border-border px-2 flex items-center justify-between gap-2 bg-background">
            <div className="min-w-0 flex items-center gap-2">
              <TerminalIcon className="size-3.5 flex-shrink-0" weight="bold" />
              <span className="font-mono text-[11px] uppercase text-foreground">Terminal</span>
              <span className="text-border select-none">/</span>
              <span className="truncate text-xs text-muted" title={projectPath}>
                {projectName}
              </span>
            </div>

            <div className="flex items-center gap-1 flex-shrink-0">
              <span
                className="hidden sm:block max-w-36 truncate border-l border-border pl-2 font-mono text-[11px] text-muted"
                title={shellTitle}
              >
                {shellLabel}
              </span>
              <button
                type="button"
                onClick={onClose}
                className="h-6 w-6 border border-transparent text-muted hover:text-foreground hover:border-border hover:bg-foreground/5 transition-colors flex items-center justify-center"
                title="Close Terminal"
                aria-label="Close Terminal"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          </div>

          <EditorTerminal
            projectPath={projectPath}
            shellMode={shellMode}
            customShell={customShell}
            className="flex-1 min-h-0"
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
