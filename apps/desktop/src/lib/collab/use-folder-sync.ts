"use client";
import { FolderSync, type SyncNotice, type SyncStatus } from "@lmms-lab/sync";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { getLink, rememberFolder, type SyncLink, serverRequest, setLink } from "./accounts";
import { desktopFolder, desktopStateStore, desktopTransport } from "./transport";

type Translate = ReturnType<typeof useI18n>["t"];
export function noticeText(notice: SyncNotice, t: Translate) {
  switch (notice.kind) {
    case "conflict-copy":
    case "deleted-remotely":
      return t(`collab.notice.${notice.kind}`, { path: notice.path, copy: notice.copy });
    case "read-only":
      return t("collab.notice.read-only", { path: notice.path });
    case "not-synced":
      return t(`collab.notice.not-synced.${notice.reason}`, {
        path: notice.path,
        detail: notice.detail ?? "",
      });
    case "paused-missing":
      return t("collab.notice.paused-missing", { count: notice.count });
  }
}

/** Runs the folder sync for the open project while it is linked to a server project. */
export function useFolderSync(projectPath: string | null) {
  const { toast } = useToast();
  const { t } = useI18n();
  // Read through refs so a re-render never restarts the running sync.
  const say = useRef({ toast, t });
  say.current = { toast, t };
  const [link, setLinkState] = useState<SyncLink | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [missing, setMissing] = useState(0);
  const engine = useRef<FolderSync | null>(null);

  useEffect(() => {
    setLinkState(null);
    setStatus(null);
    setMissing(0);
    if (!projectPath) return;
    let current = true;
    getLink(projectPath)
      .then((saved) => {
        if (!current) return;
        setLinkState(saved);
        if (saved) rememberFolder(projectPath, saved);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath || !link) return;
    const sync = new FolderSync({
      project: link.project,
      transport: desktopTransport(link.server),
      folder: desktopFolder(projectPath),
      store: desktopStateStore(projectPath),
      onStatus: setStatus,
      onNotice: (notice) => {
        if (notice.kind === "paused-missing") setMissing(notice.count);
        say.current.toast(
          noticeText(notice, say.current.t),
          notice.kind === "read-only" ? "info" : "error",
        );
      },
    });
    engine.current = sync;
    let stopListening: (() => void) | undefined,
      disposed = false;
    // Saves and agent edits show up as file events; a full rescan covers creations and moves.
    void listen<{ path: string; kind: string }>("file-changed", ({ payload }) =>
      sync.notifyLocal(payload.kind === "modify" ? [payload.path] : undefined),
    ).then((stop) => {
      if (disposed) stop();
      else stopListening = stop;
    });
    void sync.start().catch((error) => say.current.toast(String(error), "error"));
    return () => {
      disposed = true;
      stopListening?.();
      engine.current = null;
      void sync.stop();
    };
  }, [projectPath, link]);

  const linkTo = useCallback(
    async (next: SyncLink) => {
      if (!projectPath) return;
      await setLink(projectPath, next);
      rememberFolder(projectPath, next);
      setLinkState(next);
    },
    [projectPath],
  );
  const unlink = useCallback(async () => {
    if (!projectPath) return;
    await setLink(projectPath, null);
    rememberFolder(projectPath, null);
    setLinkState(null);
    setStatus(null);
  }, [projectPath]);
  /** Creates a server project from this folder; the sync then uploads every file. */
  const upload = useCallback(
    async (server: string, name: string) => {
      const created = await serverRequest<{ id: string; name: string }>(
        server,
        "POST",
        "/api/projects",
        { name },
      );
      await linkTo({ server, project: created.id, name: created.name });
      return created;
    },
    [linkTo],
  );
  const resolveMissing = useCallback((choice: "restore" | "delete") => {
    engine.current?.resolveMissing(choice);
    setMissing(0);
  }, []);
  return { link, status, missing, linkTo, unlink, upload, resolveMissing };
}
export type FolderSyncControls = ReturnType<typeof useFolderSync>;
