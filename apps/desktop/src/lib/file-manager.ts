import { invoke } from "@tauri-apps/api/core";
export type LocalFileTarget = { path: string; projectPath: string | null; directory: boolean };
export const resolveLocalFile = (project: string, path: string) =>
  invoke<LocalFileTarget>("resolve_local_file", { project, path });
export const revealInFileManager = (project: string, path: string) =>
  invoke<void>("reveal_local_file", { project, path });
