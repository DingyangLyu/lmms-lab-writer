"use client";
/** The desktop's answers to what the shared AI chat panels need (see the workbench's platform). */
import {
  type AgentPlatform,
  type ChatImageFile,
  setAgentPlatform,
  type UseBridge,
} from "@lmms-lab/workbench/agents";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open } from "@tauri-apps/plugin-shell";
import { ConversationBridge } from "@/components/bridge/conversation-bridge";
import { useConversationBridge } from "@/lib/bridge/use-conversation-bridge";

const useDesktopBridge: UseBridge = (backend, id, project, title, busy, options) => {
  const bridge = useConversationBridge(backend, id, project, title, busy, options);
  return {
    working: bridge.snapshot.conversations.some(
      (session) => session.id === bridge.fullId && Boolean(session.activeJob),
    ),
    register: bridge.register,
    view: <ConversationBridge bridge={bridge} />,
  };
};

export const desktopAgentPlatform: AgentPlatform = {
  openExternal: (url) => open(url),
  fileSource: (path) => convertFileSrc(path),
  // Outside Tauri (a browser preview) the composer falls back to the file input.
  ...(isTauri()
    ? {
        choosePaths: async (title: string) => {
          const paths = await openDialog({ multiple: true, directory: false, title });
          return paths ? (Array.isArray(paths) ? paths : [paths]) : null;
        },
        onDropPaths: (handler) =>
          getCurrentWebview().onDragDropEvent(({ payload }) => {
            if (payload.type !== "drop") return;
            handler(payload.paths, {
              x: payload.position.x / window.devicePixelRatio,
              y: payload.position.y / window.devicePixelRatio,
            });
          }),
      }
    : {}),
  readImagePath: (path) => invoke<ChatImageFile>("read_chat_image", { path }),
  importDocumentPath: (project, path) =>
    invoke<ChatImageFile>("import_chat_file", { project, path }),
  importDocumentData: (project, name, base64) =>
    invoke<ChatImageFile>("import_chat_file_data", { project, name, base64 }),
  validateDocuments: (project, files) => invoke("validate_chat_files", { project, files }),
  useBridge: useDesktopBridge,
};
setAgentPlatform(desktopAgentPlatform);
