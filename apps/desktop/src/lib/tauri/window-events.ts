import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";

/**
 * Listens to an event Rust sends to this window only (`emit_to(label, …)`). A plain `listen`
 * hears the events of every window, so per-window events (file watcher, terminals, close
 * requests, save-before-delegation) must use this.
 */
export async function listenHere<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen<T>(event, handler);
}
