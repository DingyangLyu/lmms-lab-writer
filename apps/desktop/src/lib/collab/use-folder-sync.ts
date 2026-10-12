"use client";
import { FolderSync, SyncIncomplete, type SyncNotice, type SyncStatus } from "@lmms-lab/sync";
import type { ChangeAuthor } from "@lmms-lab/sync/tracked";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { listenHere } from "@/lib/tauri/window-events";
import {
  getLink,
  listAccounts,
  rememberFolder,
  type SyncLink,
  serverRequest,
  setLink,
} from "./accounts";
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
  // Track changes, as the server project has it: for everyone, or for this member's edits.
  const [tracking, setTrackingState] = useState<{
    everyone: boolean;
    mine: boolean;
    canEdit: boolean;
  } | null>(null);
  const author = useRef<ChangeAuthor | null>(null);
  /** Bumped when a shared document changes, so its tracked changes are read again. */
  const [documents, setDocuments] = useState(0);
  /** Bumped when collaborators' cursors move. */
  const [cursorMoves, setCursorMoves] = useState(0);

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
      tracking: () => author.current,
      onDocument: () => setDocuments((n) => n + 1),
      onCursors: () => setCursorMoves((n) => n + 1),
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
    void listenHere<{ path: string; kind: string }>("file-changed", ({ payload }) =>
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

  // The tracking switches: read when linking, again every half minute (the web may change
  // them), and at once after this app changes them.
  const readTracking = useCallback(async () => {
    if (!link) return;
    const [summary, members, accounts] = await Promise.all([
      serverRequest<{ trackAll?: boolean; role?: string }>(
        link.server,
        "GET",
        `/api/projects/${link.project}`,
      ),
      serverRequest<Array<{ id: string; tracking?: boolean }>>(
        link.server,
        "GET",
        `/api/projects/${link.project}/members`,
      ),
      listAccounts(),
    ]);
    const me = accounts.find((a) => a.server === link.server)?.user;
    const mine = !!me && members.some((m) => m.id === me.id && m.tracking);
    const everyone = summary.trackAll === true;
    author.current = me && (everyone || mine) ? { author: me.id, name: me.name } : null;
    setTrackingState({
      everyone,
      mine,
      canEdit: summary.role === "owner" || summary.role === "editor",
    });
  }, [link]);
  useEffect(() => {
    author.current = null;
    setTrackingState(null);
    if (!link) return;
    void readTracking().catch(() => {});
    const timer = setInterval(() => void readTracking().catch(() => {}), 30_000);
    return () => clearInterval(timer);
  }, [link, readTracking]);
  const setTracking = useCallback(
    async (change: { everyone?: boolean; mine?: boolean }) => {
      if (!link) return;
      await serverRequest(link.server, "POST", `/api/projects/${link.project}/tracking`, change);
      await readTracking();
    },
    [link, readTracking],
  );
  /** A text file's tracked changes and the shared text they are placed in. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new function when documents change, so they are read again.
  const trackedChanges = useCallback(
    (path: string) => engine.current?.trackedChanges(path) ?? null,
    [documents],
  );
  /** Collaborators' cursors in a text file, and the shared text they are placed in. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new function when cursors or documents change, so they are read again.
  const cursors = useCallback(
    (path: string) => engine.current?.cursors(path) ?? null,
    [cursorMoves, documents],
  );
  /** Shows this computer's cursor in the open file to collaborators. */
  const setCursor = useCallback(
    (path: string | null, cursor: { anchor: number; head: number; text: string } | null) =>
      engine.current?.setCursor(path, cursor),
    [],
  );
  const decide = useCallback(
    (path: string, ids: string[] | null, accept: boolean) =>
      engine.current?.decide(path, ids, accept) ?? false,
    [],
  );

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
  /**
   * Uploads local changes now and resolves once the server has them (before a server AI turn,
   * build or version); throws while the sync is not connected and settled.
   */
  const flush = useCallback(async () => {
    const sync = engine.current;
    if (!sync) throw new Error(say.current.t("agentLocation.notSynced"));
    try {
      await sync.flush();
    } catch (error) {
      // Files the server would not take are named; the sync's notices say why.
      throw new Error(
        error instanceof SyncIncomplete
          ? say.current.t("agentLocation.notUploaded", { paths: error.paths.join(", ") })
          : say.current.t("agentLocation.notSynced"),
      );
    }
  }, []);
  const resolveMissing = useCallback((choice: "restore" | "delete") => {
    engine.current?.resolveMissing(choice);
    setMissing(0);
  }, []);
  return {
    link,
    status,
    missing,
    linkTo,
    unlink,
    upload,
    flush,
    resolveMissing,
    tracking,
    setTracking,
    trackedChanges,
    cursors,
    setCursor,
    decide,
  };
}
export type FolderSyncControls = ReturnType<typeof useFolderSync>;
