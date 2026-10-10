import { useCallback, useEffect, useState } from "react";
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

/**
 * Everything the workspace shows about a project, reloaded whenever the server reports a
 * change. Bursts of change events collapse into one reload at a time, so an older response
 * can never overwrite a newer one.
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
  const reload = useCallback(async () => {
    const all = await api<ProjectOverview>(`${prefix}/overview`);
    setSummary(all.summary);
    setFiles(all.files);
    setComments(all.comments);
    setMembers(all.members);
    setSnapshots(all.snapshots);
    setProposals(all.proposals);
    const b = all.latestBuild;
    setLatestBuild((old) => (old?.id === b?.id ? old : b));
    setFilesLoaded(true);
  }, [prefix]);
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
      again = false;
    const refresh = () => {
      if (loading) {
        again = true;
        return;
      }
      loading = true;
      void reload()
        .catch((e) => onError(errorText(e)))
        .finally(() => {
          loading = false;
          if (again && !stopped) {
            again = false;
            refresh();
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
        if (m.type === "project-changed") refresh();
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
  }, [prefix, reload, refreshSources, onRole, onError]);
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
    refreshSources,
  };
}
