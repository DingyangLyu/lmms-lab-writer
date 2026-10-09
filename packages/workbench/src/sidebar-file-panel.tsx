"use client";

import type { FileNode } from "@lmms-lab/writer-shared";
import {
  ArrowClockwiseIcon,
  CaretRightIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { EditorErrorBoundary } from "./editor-error-boundary";
import { type FileOperations, type FileSystemActions, FileTree } from "./file-tree";
import { useWorkbenchI18n as useI18n } from "./i18n";
import { DocumentOutline } from "./outline/document-outline";
import { pathSync } from "./path";

type FileSidebarPanelProps = {
  projectPath: string | null;
  files: FileNode[];
  selectedFile?: string;
  highlightedFile: string | null;
  onFileSelect: (path: string) => void;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onRefreshFiles: () => void | Promise<void>;
  /** Absent for members who may not change files. */
  fileOperations?: FileOperations;
  outlinePath?: string;
  outlineSource?: string;
  readSource: (path: string) => Promise<string | null>;
  onOutlineNavigate: (path: string, line: number) => void;
  /** Finder, Explorer and terminal actions, where the host has them. */
  system?: FileSystemActions;
  /** Extra buttons beside new file, new folder and refresh (e.g. upload). */
  actions?: ReactNode;
};

export function FileSidebarPanel({
  projectPath,
  files,
  selectedFile,
  highlightedFile,
  onFileSelect,
  onCreateFile,
  onCreateDirectory,
  onRefreshFiles,
  fileOperations,
  outlinePath,
  outlineSource,
  readSource,
  onOutlineNavigate,
  system,
  actions,
}: FileSidebarPanelProps) {
  const { t } = useI18n();
  const [filesOpen, setFilesOpen] = useState(true);
  const [loaded, setLoaded] = useState({ path: "", source: "", error: "" });
  useEffect(() => {
    setFilesOpen(localStorage.getItem("writer-files-open") !== "false");
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: File watcher refreshes invalidate the outline while the PDF is open.
  useEffect(() => {
    if (!outlinePath || outlineSource !== undefined) return;
    let cancelled = false;
    void readSource(outlinePath)
      .then((source) => {
        if (!cancelled) setLoaded({ path: outlinePath, source: source || "", error: "" });
      })
      .catch((cause) => {
        if (!cancelled) setLoaded({ path: outlinePath, source: "", error: String(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [outlinePath, outlineSource, readSource, files]);
  if (!projectPath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-muted">
        <FolderIcon className="w-8 h-8 mb-2 opacity-30" />
        <p className="text-xs">{t("files.noFolderOpen")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section
        aria-label={t("files.projectFiles")}
        className={`flex min-h-0 flex-col ${filesOpen ? "flex-[1.3]" : "shrink-0"}`}
      >
        <div
          className="px-3 py-2 border-b border-border flex shrink-0 items-center justify-between gap-2"
          title={projectPath}
        >
          <button
            type="button"
            aria-expanded={filesOpen}
            aria-label={filesOpen ? t("files.collapseFileList") : t("files.expandFileList")}
            onClick={() =>
              setFilesOpen((value) => {
                localStorage.setItem("writer-files-open", String(!value));
                return !value;
              })
            }
            className="flex min-w-0 items-center gap-1 text-xs text-muted"
          >
            <CaretRightIcon
              className={`size-3 shrink-0 transition-transform ${filesOpen ? "rotate-90" : ""}`}
            />
            <span className="truncate">{pathSync.basename(projectPath)}</span>
          </button>
          <div className="flex items-center gap-1 flex-shrink-0">
            {actions}
            <button
              type="button"
              onClick={onCreateFile}
              className="p-1 text-muted hover:text-foreground hover:bg-foreground/5 transition-colors"
              title={t("files.newFile")}
              aria-label={t("files.newFile")}
            >
              <FilePlusIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onCreateDirectory}
              className="p-1 text-muted hover:text-foreground hover:bg-foreground/5 transition-colors"
              title={t("files.newFolder")}
              aria-label={t("files.newFolder")}
            >
              <FolderPlusIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onRefreshFiles}
              className="p-1 text-muted hover:text-foreground hover:bg-foreground/5 transition-colors"
              title={t("files.refreshFiles")}
              aria-label={t("files.refreshFiles")}
            >
              <ArrowClockwiseIcon className="w-4 h-4" />
            </button>
          </div>
        </div>
        {filesOpen && (
          <EditorErrorBoundary>
            <FileTree
              files={files}
              selectedFile={selectedFile}
              highlightedFile={highlightedFile}
              onFileSelect={onFileSelect}
              className="flex-1 min-h-0 overflow-hidden"
              fileOperations={fileOperations}
              projectPath={projectPath}
              onRefresh={onRefreshFiles}
              system={system}
            />
          </EditorErrorBoundary>
        )}
      </section>
      <DocumentOutline
        path={outlinePath}
        source={outlineSource ?? (loaded.path === outlinePath ? loaded.source : "")}
        error={
          outlineSource === undefined && loaded.path === outlinePath ? loaded.error : undefined
        }
        onNavigate={(line) => {
          if (outlinePath) onOutlineNavigate(outlinePath, line);
        }}
      />
    </div>
  );
}
