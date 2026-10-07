"use client";

import type { PanInfo } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

export type ResizablePanel = "sidebar" | "right";
const MIN_PANEL_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const DEFAULT_WIDTH = 280;

function savedWidth(key: string) {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const value = Number.parseInt(localStorage.getItem(key) ?? "", 10);
    return Number.isFinite(value) && value >= MIN_PANEL_WIDTH ? value : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/**
 * Sidebar and right panel widths, persisted per machine. While dragging, widths go to CSS
 * variables once per animation frame; React state is updated only when the drag ends.
 */
export function usePanelResize() {
  const [sidebarWidth, setSidebarWidth] = useState(() => savedWidth("sidebarWidth"));
  const [rightPanelWidth, setRightPanelWidth] = useState(() => savedWidth("rightPanelWidth"));
  const [resizing, setResizing] = useState<ResizablePanel | null>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const rightPanelWidthRef = useRef(rightPanelWidth);
  const rafIdRef = useRef<number | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem("sidebarWidth", String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);
  useEffect(() => {
    try {
      localStorage.setItem("rightPanelWidth", String(rightPanelWidth));
    } catch {}
  }, [rightPanelWidth]);
  const startResize = useCallback(
    (panel: ResizablePanel) => {
      setResizing(panel);
      sidebarWidthRef.current = sidebarWidth;
      rightPanelWidthRef.current = rightPanelWidth;
      document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
      document.documentElement.style.setProperty("--right-panel-width", `${rightPanelWidth}px`);
    },
    [sidebarWidth, rightPanelWidth],
  );
  const handleResizeDrag = useCallback((panel: ResizablePanel, info: PanInfo) => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      if (panel === "sidebar") {
        const width = Math.min(Math.max(info.point.x, MIN_PANEL_WIDTH), MAX_SIDEBAR_WIDTH);
        sidebarWidthRef.current = width;
        document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
      } else {
        const width = Math.min(
          Math.max(window.innerWidth - info.point.x, MIN_PANEL_WIDTH),
          Math.floor(window.innerWidth / 2),
        );
        rightPanelWidthRef.current = width;
        document.documentElement.style.setProperty("--right-panel-width", `${width}px`);
      }
      rafIdRef.current = null;
    });
  }, []);
  const endResize = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setSidebarWidth(sidebarWidthRef.current);
    setRightPanelWidth(rightPanelWidthRef.current);
    document.documentElement.style.removeProperty("--sidebar-width");
    document.documentElement.style.removeProperty("--right-panel-width");
    setResizing(null);
  }, []);
  return { sidebarWidth, rightPanelWidth, resizing, startResize, handleResizeDrag, endResize };
}
