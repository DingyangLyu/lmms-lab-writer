"use client";
import { type ProjectHints, projectHints } from "@lmms-lab/workbench";
/**
 * The project's citation keys and labels for the editor's completion, as the web gathers them
 * from its shared sources: read from the folder's .bib and .tex files when the file list
 * changes and again after saves.
 */
import type { FileNode } from "@lmms-lab/writer-shared";
import { parseBib } from "@lmms-lab/writing";
import { invoke } from "@tauri-apps/api/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { listenHere } from "@/lib/tauri/window-events";

const NONE: ProjectHints = { citations: [], labels: [] };
/** Files read at most, so a huge folder does not stall the editor. */
const MAX_FILES = 200;
const Context = createContext<() => ProjectHints>(() => NONE);
export const useProjectHints = () => useContext(Context);

function sourcePaths(nodes: FileNode[], out: string[] = []) {
  for (const node of nodes) {
    if (out.length >= MAX_FILES) break;
    if (node.type === "directory") sourcePaths(node.children ?? [], out);
    else if (/\.(tex|bib)$/i.test(node.path)) out.push(node.path);
  }
  return out;
}

export function ProjectHintsProvider({
  project,
  files,
  children,
}: {
  project: string | null;
  files: FileNode[];
  children: ReactNode;
}) {
  const [hints, setHints] = useState<ProjectHints>(NONE);
  // Saved .tex and .bib files (the folder watcher's events) bring new labels and keys.
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let stop: (() => void) | undefined,
      disposed = false;
    void listenHere<{ path: string }>("file-changed", ({ payload }) => {
      if (/\.(tex|bib)$/i.test(payload.path ?? "")) setRevision((n) => n + 1);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const latest = useRef(hints);
  latest.current = hints;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` only says to read again.
  useEffect(() => {
    if (!project) return setHints(NONE);
    let current = true;
    const timer = setTimeout(async () => {
      const sources: { path: string; content: string }[] = [];
      for (const path of sourcePaths(files)) {
        try {
          sources.push({ path, content: await invoke<string>("read_document", { project, path }) });
        } catch {
          // Unreadable or too large: its keys are simply not offered.
        }
      }
      if (current) setHints(projectHints(sources, parseBib));
    }, 600);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [project, files, revision]);
  return <Context.Provider value={() => latest.current}>{children}</Context.Provider>;
}
