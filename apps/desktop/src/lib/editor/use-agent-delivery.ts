"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect } from "react";
import { i18n } from "@/lib/i18n";
import { openedProjectPath } from "@/lib/project-root";
import type { SaveManager } from "./save-manager";
import { type EditorSelectionContext, selectionMatchesDocument } from "./selection-context";

/**
 * Agents must see what the user sees. Before a message (or a delegated turn) reaches an
 * agent, open buffers are saved, and the referenced documents get a backup checkpoint.
 */
export function useAgentDelivery(saveManager: SaveManager, projectPath: string | null) {
  /** Before sending a chat message that may quote the editor selection. */
  const prepareEditorMessage = useCallback(
    async (selection: EditorSelectionContext | null) => {
      if (projectPath) await saveManager.synchronize(projectPath);
      if (!selection) return;
      if (selection.project !== projectPath)
        throw new Error(i18n.t("msg.theProjectChangedSelectTheTextToQuoteAga"));
      const content = await invoke<string>("read_document", {
        project: selection.project,
        path: selection.path,
      });
      if (!selectionMatchesDocument(selection, content))
        throw new Error(i18n.t("msg.theSelectedTextHasChangedSelectItAgainBe"));
      await invoke("checkpoint_document", {
        project: selection.project,
        path: selection.path,
        expected: content,
      });
    },
    [saveManager, projectPath],
  );
  // The Rust bridge asks for the same preparation before a delegated turn starts.
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ id: string; project: string; files?: string[]; checkpoint?: boolean }>(
          "writer://prepare-delivery",
          async ({ payload }) => {
            let error: string | null = null;
            // Buffers are keyed by the opened path; the bridge sends the canonical root.
            const project = openedProjectPath(payload.project);
            try {
              await saveManager.synchronize(project, payload.files);
              for (const doc of saveManager.documents.values()) {
                if (
                  payload.checkpoint !== false &&
                  doc.project === project &&
                  (!payload.files || payload.files.includes(doc.path)) &&
                  /\.(tex|bib)$/i.test(doc.path)
                )
                  await invoke("checkpoint_document", {
                    project: doc.project,
                    path: doc.path,
                    expected: doc.content,
                  });
              }
            } catch (cause) {
              error = i18n.t("msg.savingBeforeDelegationFailedError", { error: String(cause) });
            }
            await invoke("writer_delivery_prepared", { id: payload.id, error });
          },
        ),
      )
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [saveManager]);
  return { prepareEditorMessage };
}
