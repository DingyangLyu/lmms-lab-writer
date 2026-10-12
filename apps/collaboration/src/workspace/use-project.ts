import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Build,
  Comment,
  FileInfo,
  Member,
  ProjectOverview,
  ProjectSummary,
  Proposal,
  Role,
  Snapshot,
  SourceFile,
} from "../../shared/api";
import { api, errorText } from "../api";
import { i18n } from "../i18n";
import { INBOX_EVENT } from "../inbox";

/** The project socket's chat messages, as a window event (see chat-panel.tsx). */
export const CHAT_EVENT = "writer-chat";

/**
 * A change to the comments shown before the server has it (a comment just posted, a reply,
 * a thread resolved), laid over what the server last sent until a reload made after the
 * request finished includes it.
 */
export type CommentChange = {
  /** Shows the change again (with the server's answer, say). */
  update: (apply: (list: Comment[]) => Comment[]) => void;
  /** The server has it: the next reload shows it by itself. */
  settle: () => void;
  /** The request failed: the comments are shown as the server has them. */
  undo: () => void;
};

/**
 * Everything the workspace shows about a project, reloaded whenever the server reports a
 * change. Bursts of change events collapse into one reload at a time, so an older response
 * can never overwrite a newer one. Comment changes reload the comments alone.
 */
export function useProject(
  prefix: string,
  callbacks: { onRole: (role: Role) => void; onError: (message: string) => void },
) {
  const [files, setFiles] = useState<FileInfo[]>([]),
    [comments, setComments] = useState<Comment[]>([]),
    [members, setMembers] = useState<Member[]>([]),
    [snapshots, setSnapshots] = useState<Snapshot[]>([]),
    [proposals, setProposals] = useState<Proposal[]>([]),
    [latestBuild, setLatestBuild] = useState<Build | null>(null),
    // The project's current name and settings: anyone may rename it while it is open.
    [summary, setSummary] = useState<ProjectSummary | null>(null),
    [sources, setSources] = useState<SourceFile[]>([]),
    // Files, the latest build and the sources have all been read once.
    [filesLoaded, setFilesLoaded] = useState(false),
    [sourcesLoaded, setSourcesLoaded] = useState(false);
  const { onRole, onError } = callbacks;
  // The server's comments, the changes laid over them, and how many loads have started.
  const served = useRef<Comment[]>([]),
    overlays = useRef(
      new Map<number, { apply: (list: Comment[]) => Comment[]; settled: number | null }>(),
    ),
    loads = useRef(0),
    nextChange = useRef(0);
  const showComments = useCallback(() => {
    let list = served.current;
    for (const overlay of overlays.current.values()) list = overlay.apply(list);
    setComments(list);
  }, []);
  /** The server's list from a load started as number `started`. */
  const received = useCallback(
    (list: Comment[], started: number) => {
      served.current = list;
      // Loads begun after a request finished include its change.
      for (const [key, overlay] of overlays.current)
        if (overlay.settled !== null && started > overlay.settled) overlays.current.delete(key);
      showComments();
    },
    [showComments],
  );
  const changeComments = useCallback(
    (apply: (list: Comment[]) => Comment[]): CommentChange => {
      const key = ++nextChange.current;
      const overlay = { apply, settled: null as number | null };
      overlays.current.set(key, overlay);
      showComments();
      return {
        update: (next) => {
          overlay.apply = next;
          showComments();
        },
        settle: () => {
          overlay.settled = loads.current;
        },
        undo: () => {
          overlays.current.delete(key);
          showComments();
        },
      };
    },
    [showComments],
  );
  const reloadComments = useCallback(async () => {
    const started = ++loads.current;
    received(await api<Comment[]>(`${prefix}/comments`), started);
  }, [prefix, received]);
  const reload = useCallback(async () => {
    const started = ++loads.current;
    const all = await api<ProjectOverview>(`${prefix}/overview`);
    setSummary(all.summary);
    setFiles(all.files);
    received(all.comments, started);
    setMembers(all.members);
    setSnapshots(all.snapshots);
    setProposals(all.proposals);
    const b = all.latestBuild;
    setLatestBuild((old) => (old?.id === b?.id ? old : b));
    setFilesLoaded(true);
  }, [prefix, received]);
  /** Project text for citation and label completion and the bibliography tab. */
  const refreshSources = useCallback(async () => {
    const next = await api<SourceFile[]>(`${prefix}/sources`);
    setSources(next);
    return next;
  }, [prefix]);
  useEffect(() => {
    let socket: WebSocket | null = null,
      stopped = false,
      retry: ReturnType<typeof setTimeout> | null = null,
      loading = false,
      // What the next load must cover: everything, or the comments alone.
      again: "all" | "comments" | null = null;
    const refresh = (what: "all" | "comments" = "all") => {
      if (loading) {
        again = again === "all" || what === "all" ? "all" : "comments";
        return;
      }
      loading = true;
      void (what === "comments" ? reloadComments() : reload())
        .catch((e) => onError(errorText(e)))
        .finally(() => {
          loading = false;
          if (again && !stopped) {
            const next = again;
            again = null;
            refresh(next);
          }
        });
    };
    refresh();
    void refreshSources()
      .catch(() => {})
      .finally(() => setSourcesLoaded(true));
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api${prefix}/socket`,
      );
      socket.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "project-changed") refresh(m.scope === "comments" ? "comments" : "all");
        if (m.type === "notification") window.dispatchEvent(new Event(INBOX_EVENT));
        if (m.type === "chat")
          window.dispatchEvent(
            new CustomEvent(CHAT_EVENT, {
              detail: { project: prefix.slice(prefix.lastIndexOf("/") + 1), message: m.message },
            }),
          );
        if (m.type === "ready") onRole(m.role);
      };
      socket.onclose = (e) => {
        if (stopped) return;
        if (e.code !== 1008) {
          retry = setTimeout(connect, 1500);
          return;
        }
        // Closed for lost access: ask once more before believing it, so a server hiccup never
        // turns a member into a viewer until they reload.
        void fetch(`/api${prefix}`, { credentials: "same-origin" })
          .then(async (response) => {
            if (stopped) return;
            if (response.ok) {
              onRole(((await response.json()) as ProjectSummary).role);
              retry = setTimeout(connect, 1500);
            } else if ([401, 403, 404].includes(response.status)) {
              onRole("viewer");
              onError(i18n.t("project.roleChanged"));
            } else retry = setTimeout(connect, 3000);
          })
          // The server is unreachable for now: try again, as for any dropped connection.
          .catch(() => {
            if (!stopped) retry = setTimeout(connect, 3000);
          });
      };
    };
    connect();
    return () => {
      stopped = true;
      socket?.close();
      if (retry) clearTimeout(retry);
    };
  }, [prefix, reload, reloadComments, refreshSources, onRole, onError]);
  return {
    loaded: filesLoaded && sourcesLoaded,
    summary,
    files,
    comments,
    members,
    snapshots,
    proposals,
    latestBuild,
    sources,
    reload,
    reloadComments,
    changeComments,
    refreshSources,
  };
}
