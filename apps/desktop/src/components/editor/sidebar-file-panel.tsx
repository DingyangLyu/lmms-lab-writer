"use client";
import { FileSidebarPanel as SharedFileSidebarPanel } from "@lmms-lab/workbench";
import type { ComponentProps } from "react";
import { desktopFileSystem } from "@/lib/file-system-actions";

/** The shared files sidebar with Finder/Explorer and terminal actions. */
export function FileSidebarPanel(props: ComponentProps<typeof SharedFileSidebarPanel>) {
  return <SharedFileSidebarPanel system={desktopFileSystem} {...props} />;
}
