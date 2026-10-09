/**
 * The Y-Writer workbench shared by the desktop app and the web editor: the same file tree,
 * tabs, LaTeX editor, outline and PDF preview, styled by theme.css. Anything specific to one
 * app (Tauri commands, server requests) is passed in through props or a context. The PDF
 * preview loads pdf.js, so it has its own entry: `@lmms-lab/workbench/pdf-viewer`.
 */
export * from "./comments/comment-thread";
export * from "./comments/locate-quote";
export * from "./editor/drag-selection";
export * from "./editor/font-stacks";
export * from "./editor/latex-source-editor";
export * from "./editor/types";
export * from "./editor-error-boundary";
export * from "./file-tree";
export * from "./i18n";
export * from "./outline/document-outline";
export * from "./outline/latex-outline";
export * from "./path";
export * from "./pdf/annotation-bridge";
export * from "./pdf/annotations";
export * from "./pdf/text-selection";
export * from "./pdf/viewport";
export * from "./random-id";
export * from "./sidebar-file-panel";
export * from "./ui/confirm-dialog";
export * from "./ui/context-menu";
export * from "./ui/input-dialog";
export * from "./ui/panel-height";
export * from "./ui/tab-bar";
