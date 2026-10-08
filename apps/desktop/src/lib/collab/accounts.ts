import { invoke } from "@tauri-apps/api/core";
import { requestError } from "./transport";

export type CollabUser = { id: string; name: string; admin: boolean; mustChange: boolean };
export type CollabAccount = { server: string; user: CollabUser };
export type SyncLink = { server: string; project: string; name: string };
export type ServerProject = { id: string; name: string; role: string };

/** Command names stay literal so the IPC contract test can check every call. */
const guard = async <T>(pending: Promise<T>) => {
  try {
    return await pending;
  } catch (error) {
    throw requestError(error);
  }
};

export const listAccounts = () => guard(invoke<CollabAccount[]>("collab_accounts"));
/** How this computer appears in the server's device and runner lists. */
export async function deviceName() {
  try {
    const { hostname } = await import("@tauri-apps/plugin-os");
    return `Writer Desktop · ${(await hostname()) ?? "unknown"}`;
  } catch {
    return "Writer Desktop";
  }
}
export async function signIn(server: string, username: string, password: string) {
  const device = await deviceName();
  return guard(invoke<CollabAccount>("collab_sign_in", { server, username, password, device }));
}
export const signOut = (server: string) => guard(invoke<void>("collab_sign_out", { server }));
export const serverRequest = <T>(server: string, method: string, path: string, body?: unknown) =>
  guard(invoke<T>("collab_request", { server, method, path, body: body ?? null }));

export const getLink = (project: string) =>
  guard(invoke<SyncLink | null>("sync_link_get", { project }));
export const setLink = (project: string, link: SyncLink | null) =>
  guard(invoke<void>("sync_link_set", { project, link }));

/** Linked folders on this computer, so a link from the web page can reopen the right one. */
const FOLDERS = "writer-sync-folders";
type FolderEntry = SyncLink & { path: string };
export function linkedFolders(): FolderEntry[] {
  try {
    return JSON.parse(localStorage.getItem(FOLDERS) || "[]") as FolderEntry[];
  } catch {
    return [];
  }
}
export function rememberFolder(path: string, link: SyncLink | null) {
  const rest = linkedFolders().filter((f) => f.path !== path);
  try {
    localStorage.setItem(FOLDERS, JSON.stringify(link ? [...rest, { ...link, path }] : rest));
  } catch {
    // Only the shortcut from web links is lost.
  }
}
