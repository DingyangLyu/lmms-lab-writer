"use client";

import type { SaveResult } from "@lmms-lab/writing";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { i18n } from "@/lib/i18n";
import { listenHere } from "@/lib/tauri/window-events";
import { SaveManager } from "./save-manager";

/**
 * `beforeClose` may veto closing this window or quitting (e.g. agents still running); editor
 * drafts are flushed after.
 */
export function useDocumentSaving(beforeClose?: (quit: boolean) => Promise<boolean>) {
  const beforeCloseRef = useRef(beforeClose);
  beforeCloseRef.current = beforeClose;
  const [manager] = useState(
    () =>
      new SaveManager(
        (draft) =>
          invoke<SaveResult>("merge_save_document", {
            project: draft.project,
            path: draft.path,
            content: draft.content,
            expected: draft.base,
          }),
        {
          get length() {
            return localStorage.length;
          },
          key: (index) => localStorage.key(index),
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => localStorage.setItem(key, value),
          removeItem: (key) => localStorage.removeItem(key),
        },
        500,
        (project, path) => invoke<string>("read_document", { project, path }),
      ),
  );
  const [revision, setRevision] = useState(0);
  const [closeError, setCloseError] = useState<string | null>(null);
  useEffect(() => manager.subscribe(() => setRevision((revision) => revision + 1)), [manager]);
  useEffect(() => {
    let disposed = false;
    let closing = false;
    let unlisten: (() => void) | undefined;
    void listenHere<{ quit: boolean }>("writer-close-requested", async ({ payload }) => {
      if (closing) return;
      closing = true;
      try {
        if (beforeCloseRef.current && !(await beforeCloseRef.current(payload.quit))) return;
        await manager.flushAll();
        await invoke("finish_close", { quit: payload.quit });
      } catch (error) {
        setCloseError(
          i18n.t("msg.closingWasCancelledBecauseSomeFilesAreNo", { error: String(error) }),
        );
      } finally {
        closing = false;
      }
    })
      .then(async (stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        await invoke("register_save_guard");
      })
      .catch((error) =>
        setCloseError(i18n.t("msg.closeProtectionIsNotActiveError", { error: String(error) })),
      );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ([...manager.documents.values()].some((doc) => doc.dirty || doc.saving)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const flush = () => {
      void manager.flushAll().catch(() => {});
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("blur", flush);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("blur", flush);
    };
  }, [manager]);
  return { manager, revision, closeError, clearCloseError: () => setCloseError(null) };
}
