"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useTheme } from "next-themes";
import { memo, useEffect, useRef, useState } from "react";
import { resolveTerminalFontFamily } from "@/lib/editor/font-stacks";
import { useI18n } from "@/lib/i18n";

// GitHub Light terminal colors
const LIGHT_TERMINAL_THEME = {
  background: "#ffffff",
  foreground: "#24292e",
  cursor: "#24292e",
  cursorAccent: "#ffffff",
  selectionBackground: "#c8c8fa",
  black: "#24292e",
  red: "#d73a49",
  green: "#22863a",
  yellow: "#e36209",
  blue: "#005cc5",
  magenta: "#6f42c1",
  cyan: "#032f62",
  white: "#fafbfc",
  brightBlack: "#959da5",
  brightRed: "#cb2431",
  brightGreen: "#28a745",
  brightYellow: "#f9826c",
  brightBlue: "#79b8ff",
  brightMagenta: "#b392f0",
  brightCyan: "#0366d6",
  brightWhite: "#ffffff",
};

// GitHub Dark terminal colors (matched to app dark theme)
const DARK_TERMINAL_THEME = {
  background: "#2c323a",
  foreground: "#c9d1d9",
  cursor: "#d1d5da",
  cursorAccent: "#2c323a",
  selectionBackground: "#3b4048",
  black: "#2c323a",
  red: "#f85149",
  green: "#56d364",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#a371f7",
  cyan: "#76d9e6",
  white: "#c9d1d9",
  brightBlack: "#8b949e",
  brightRed: "#ffa198",
  brightGreen: "#7ee787",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#bc8cff",
  brightCyan: "#a5d6ff",
  brightWhite: "#e6edf3",
};

type Props = {
  projectPath?: string;
  shellMode?: "auto" | "custom";
  customShell?: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  className?: string;
};

type XTermDisposable = {
  dispose: () => void;
};

export const Terminal = memo(function Terminal({
  projectPath,
  shellMode = "auto",
  customShell = "",
  fontFamily = "",
  fontSize = 13,
  lineHeight = 1.4,
  className = "",
}: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const themeRef = useRef(LIGHT_TERMINAL_THEME);
  const fontRef = useRef({
    fontFamily: resolveTerminalFontFamily(fontFamily),
    fontSize,
    lineHeight,
  });
  // Client-side mount check - intentionally set in effect for hydration safety
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  // Reactively update terminal theme when app mode changes
  useEffect(() => {
    const nextTheme = resolvedTheme === "dark" ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
    themeRef.current = nextTheme;

    if (termRef.current) {
      termRef.current.options.theme = nextTheme;
    }
  }, [resolvedTheme]);

  useEffect(() => {
    const nextFont = {
      fontFamily: resolveTerminalFontFamily(fontFamily),
      fontSize,
      lineHeight,
    };
    fontRef.current = nextFont;

    if (termRef.current) {
      termRef.current.options.fontFamily = nextFont.fontFamily;
      termRef.current.options.fontSize = nextFont.fontSize;
      termRef.current.options.lineHeight = nextFont.lineHeight;
      fitAddonRef.current?.fit();
    }
  }, [fontFamily, fontSize, lineHeight]);

  useEffect(() => {
    if (!mounted || !containerRef.current || !projectPath) return;

    const preferredShell =
      shellMode === "custom" && customShell.trim().length > 0 ? customShell.trim() : null;

    // Track cleanup state to prevent zombie processes
    let isCleanedUp = false;
    let ptyId: string | null = null;
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let dataDisposable: XTermDisposable | null = null;
    let resizeDisposable: XTermDisposable | null = null;
    let fitFrameId: number | null = null;
    const pendingOutput = new Map<string, string[]>();
    const pendingExit = new Map<string, number>();

    const term = new XTerm({
      fontFamily: fontRef.current.fontFamily,
      fontSize: fontRef.current.fontSize,
      lineHeight: fontRef.current.lineHeight,
      letterSpacing: 0,
      theme: themeRef.current,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10000,
      screenReaderMode: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const setup = async () => {
      try {
        // Check if already cleaned up before spawning
        if (isCleanedUp) return;

        unlistenOutput = await listen<{ id: string; data: string }>("pty-output", (event) => {
          if (isCleanedUp) {
            return;
          }

          const { id, data } = event.payload;
          if (id === ptyId) {
            term.write(data);
            return;
          }

          if (ptyId === null) {
            const bufferedOutput = pendingOutput.get(id) ?? [];
            bufferedOutput.push(data);
            pendingOutput.set(id, bufferedOutput);
          }
        });

        // Check again after async operation
        if (isCleanedUp) {
          unlistenOutput?.();
          invoke("kill_pty", { id: ptyId }).catch(console.error);
          return;
        }

        unlistenExit = await listen<{ id: string; code: number }>("pty-exit", (event) => {
          if (isCleanedUp) {
            return;
          }

          const { id, code } = event.payload;
          if (id === ptyId) {
            term.write(`\r\n[Process exited with code ${code}]\r\n`);
            ptyId = null;
            return;
          }

          if (ptyId === null) {
            pendingExit.set(id, code);
          }
        });

        // Check again after async operation
        if (isCleanedUp) {
          unlistenOutput?.();
          unlistenExit?.();
          invoke("kill_pty", { id: ptyId }).catch(console.error);
          return;
        }

        dataDisposable = term.onData((data) => {
          if (ptyId && !isCleanedUp) {
            invoke("write_pty", { id: ptyId, data }).catch(console.error);
          }
        });

        resizeDisposable = term.onResize(({ cols, rows }) => {
          if (ptyId && !isCleanedUp) {
            invoke("resize_pty", { id: ptyId, cols, rows }).catch(console.error);
          }
        });

        const spawnedPtyId = await invoke<string>("spawn_pty", {
          cwd: projectPath,
          cols: term.cols,
          rows: term.rows,
          shell: preferredShell,
        });

        // Check again after async operation
        if (isCleanedUp) {
          // Component unmounted during spawn - kill the orphan process
          invoke("kill_pty", { id: spawnedPtyId }).catch(console.error);
          return;
        }

        ptyId = spawnedPtyId;

        const bufferedOutput = pendingOutput.get(spawnedPtyId);
        if (bufferedOutput) {
          for (const data of bufferedOutput) {
            term.write(data);
          }
          pendingOutput.delete(spawnedPtyId);
        }

        const exitCode = pendingExit.get(spawnedPtyId);
        if (exitCode !== undefined) {
          term.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
          ptyId = null;
          pendingExit.delete(spawnedPtyId);
        }
      } catch (err) {
        if (!isCleanedUp) {
          console.error("Failed to spawn PTY:", err);
          term.write(`\r\nFailed to start terminal: ${err}\r\n`);
        }
      }
    };

    setup();

    const fitTerminal = () => {
      if (fitFrameId !== null) {
        return;
      }

      fitFrameId = window.requestAnimationFrame(() => {
        fitFrameId = null;
        fitAddonRef.current?.fit();
      });
    };

    window.addEventListener("resize", fitTerminal);

    const resizeObserver = new ResizeObserver(() => {
      fitTerminal();
    });
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      // Mark as cleaned up FIRST to prevent race conditions
      isCleanedUp = true;

      window.removeEventListener("resize", fitTerminal);
      resizeObserver.disconnect();
      if (fitFrameId !== null) {
        window.cancelAnimationFrame(fitFrameId);
      }

      // Clean up listeners
      unlistenOutput?.();
      unlistenExit?.();
      dataDisposable?.dispose();
      resizeDisposable?.dispose();

      // Kill PTY process if it exists
      if (ptyId) {
        invoke("kill_pty", { id: ptyId }).catch(console.error);
      }

      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [mounted, projectPath, shellMode, customShell]);

  if (!mounted) {
    return (
      <div className={`bg-background ${className}`}>
        <div className="p-4 text-sm text-muted">{t("ui.loadingTerminal")}</div>
      </div>
    );
  }

  if (!projectPath) {
    return (
      <div className={`bg-background flex items-center justify-center ${className}`}>
        <span className="text-sm text-muted">{t("ui.openAProjectToUseTerminal")}</span>
      </div>
    );
  }

  return (
    <div className={`bg-background ${className}`}>
      <div ref={containerRef} className="terminal-xterm w-full h-full p-2" />
    </div>
  );
});
