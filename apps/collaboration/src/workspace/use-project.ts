import { useCallback, useEffect, useState } from "react";
import type {
  Build,
  Comment,
  FileInfo,
  Member,
  Proposal,
  Role,
  SharedJob,
  Snapshot,
  SourceFile,
} from "../../shared/api";
import { api } from "../api";

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
    [jobs, setJobs] = useState<SharedJob[]>([]),
    [latestBuild, setLatestBuild] = useState<Build | null>(null),
    [sources, setSources] = useState<SourceFile[]>([]);
  const { onRole, onError } = callbacks;
  const reload = useCallback(async () => {
    const [f, c, m, s, p, j, b] = await Promise.all([
      api<FileInfo[]>(`${prefix}/files`),
      api<Comment[]>(`${prefix}/comments`),
      api<Member[]>(`${prefix}/members`),
      api<Snapshot[]>(`${prefix}/snapshots`),
      api<Proposal[]>(`${prefix}/proposals`),
      api<SharedJob[]>(`${prefix}/jobs`),
      api<Build | null>(`${prefix}/builds/latest`),
    ]);
    setFiles(f);
    setComments(c);
    setMembers(m);
    setSnapshots(s);
    setProposals(p);
    setJobs(j);
    setLatestBuild((old) => (old?.id === b?.id ? old : b));
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
        .catch((e) => onError(String(e)))
        .finally(() => {
          loading = false;
          if (again && !stopped) {
            again = false;
            refresh();
          }
        });
    };
    refresh();
    void refreshSources().catch(() => {});
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
        if (!stopped && e.code !== 1008) retry = setTimeout(connect, 1500);
        else if (!stopped) {
          onRole("viewer");
          onError("项目权限已变更，请返回项目列表重新进入。");
        }
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
    files,
    comments,
    members,
    snapshots,
    proposals,
    jobs,
    latestBuild,
    sources,
    reload,
    refreshSources,
  };
}
