/**
 * What the AI chat panels need from the app around them. The desktop app answers with Tauri
 * (system browser, file dialogs, attachment copies in the project, the cross-conversation
 * bridge); the web app with the browser. Each app registers its platform once at start-up,
 * before any panel renders.
 */
import type { ReactNode } from "react";
import type { ChatImageFile } from "./chat/images";

/** Cross-conversation delegation (desktop): who is working, and the bridge's status bar. */
export type BridgeHandle = {
  /** The conversation is busy with a delegated task. */
  working: boolean;
  register: (id: string) => Promise<void>;
  view: ReactNode;
};
export type UseBridge = (
  backend: string,
  id: string | null,
  project: string | undefined,
  title: string,
  busy: boolean,
  options: Record<string, unknown>,
) => BridgeHandle;

export type AgentPlatform = {
  /** A web link, in the system browser (desktop) or a new tab (web). */
  openExternal: (url: string) => void | Promise<void>;
  /** A URL the page can load for a file on this computer; undefined where it cannot. */
  fileSource?: (path: string) => string | undefined;
  /** Native file choosing and dropping by path (desktop); otherwise the file input is used. */
  choosePaths?: (title: string) => Promise<string[] | null>;
  onDropPaths?: (
    handler: (paths: string[], position: { x: number; y: number }) => void,
  ) => Promise<() => void>;
  readImagePath?: (path: string) => Promise<ChatImageFile>;
  /** Copies a non-image file into the project for the agent to read; absent on the web. */
  importDocumentPath?: (project: string, path: string) => Promise<ChatImageFile>;
  importDocumentData?: (project: string, name: string, base64: string) => Promise<ChatImageFile>;
  validateDocuments?: (project: string, files: ChatImageFile[]) => Promise<void>;
  useBridge?: UseBridge;
};

const noBridge: UseBridge = () => ({ working: false, register: async () => {}, view: null });
let current: AgentPlatform = {
  openExternal: (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
};
export function setAgentPlatform(platform: AgentPlatform) {
  current = platform;
}
export const agentPlatform = () => current;
/** Stable for the app's lifetime, so calling it is an ordinary hook call. */
export const useBridge: UseBridge = (...args) => (current.useBridge ?? noBridge)(...args);
