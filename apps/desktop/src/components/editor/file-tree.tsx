"use client";
import { FileTree as SharedFileTree } from "@lmms-lab/workbench";
import type { ComponentProps } from "react";
import { desktopFileSystem } from "@/lib/file-system-actions";

export type { FileOperations } from "@lmms-lab/workbench";

/** The shared file tree with Finder/Explorer and terminal actions. */
export function FileTree(props: ComponentProps<typeof SharedFileTree>) {
  return <SharedFileTree system={desktopFileSystem} {...props} />;
}
