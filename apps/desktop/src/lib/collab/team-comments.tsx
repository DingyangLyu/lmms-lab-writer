"use client";
/**
 * Comments shared on the collaboration server, for a folder linked to a server project: the
 * same threads co-authors see in the web editor. They are shown beside the local (AI-oriented)
 * annotations, and a new comment can go to the team instead of this computer only.
 */
import { locateQuote, pathSync, type SourceMark, type ThreadComment } from "@lmms-lab/workbench";
import { invoke } from "@tauri-apps/api/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SynctexResult } from "@/lib/latex/types";
import type { AnnotationDraft } from "@/lib/pdf/annotation-context";
import { getLink, listAccounts, type SyncLink, serverRequest } from "./accounts";

export type TeamComment = ThreadComment & { path: string | null };
type ServerFile = { id: string; path: string; binary: boolean };

/** Where each open thread lies in a local copy of its file; threads whose text differs are left out. */
export function teamMarks(comments: TeamComment[], path: string, content: string): SourceMark[] {
  const marks: SourceMark[] = [];
  const lineAt = (offset: number) => content.slice(0, offset).split("\n").length;
  for (const c of comments) {
    if (c.resolved || c.path !== path || c.from === null || c.to === null || !c.excerpt) continue;
    let from = c.from;
    // The local copy may differ before the anchor (unsynced edits): look for the text nearby.
    if (content.slice(from, from + c.excerpt.length) !== c.excerpt) {
      const near = content.indexOf(c.excerpt, Math.max(0, from - 2000));
      if (near < 0 || Math.abs(near - from) > 4000) continue;
      from = near;
    }
    // The server shortens the excerpt of very long anchors; then the anchor's length counts.
    const to = from + (c.excerpt.length < 4000 ? c.excerpt.length : c.to - c.from);
    marks.push({
      id: `team:${c.id}`,
      comment: `${c.authorName}: ${c.body}`,
      style: "highlight",
      resolved: false,
      ranges: [
        {
          start: from,
          end: to,
          text: content.slice(from, to),
          state: "active",
          line: lineAt(from),
          endLine: lineAt(to),
        },
      ],
    });
  }
  return marks;
}

type Team = {
  link: SyncLink | null;
  comments: TeamComment[];
  me: string | null;
  role: string | null;
  busy: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  focus: string | null;
  setFocus: (id: string | null) => void;
  refresh: () => Promise<void>;
  /** A request inside the linked project, then a refresh. */
  act: (method: string, path: string, body?: unknown) => Promise<void>;
  /** Post a desktop comment draft (a text or PDF selection) as a team comment. */
  share: (draft: AnnotationDraft) => Promise<void>;
};
const TeamContext = createContext<Team | null>(null);
export const useTeamComments = () => useContext(TeamContext);

const REFRESH_MS = 20_000;

export function TeamCommentsProvider({
  projectPath,
  children,
}: {
  projectPath: string | null;
  children: ReactNode;
}) {
  const [link, setLink] = useState<SyncLink | null>(null),
    [comments, setComments] = useState<TeamComment[]>([]),
    [files, setFiles] = useState<ServerFile[]>([]),
    [me, setMe] = useState<string | null>(null),
    [role, setRole] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [open, setOpen] = useState(false),
    [focus, setFocus] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    setLink(null);
    setComments([]);
    setFiles([]);
    setOpen(false);
    setFocus(null);
    setError(null);
    if (!projectPath) return;
    let current = true;
    void Promise.all([getLink(projectPath), listAccounts()])
      .then(([found, accounts]) => {
        if (!current) return;
        setLink(found);
        setMe(accounts.find((a) => a.server === found?.server)?.user.id ?? null);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [projectPath]);
  const refresh = useCallback(async () => {
    if (!link) return;
    const id = ++request.current;
    const base = `/api/projects/${encodeURIComponent(link.project)}`;
    try {
      const [list, fileList, summary] = await Promise.all([
        serverRequest<ThreadComment[]>(link.server, "GET", `${base}/comments`),
        serverRequest<ServerFile[]>(link.server, "GET", `${base}/files`),
        serverRequest<{ role: string }>(link.server, "GET", base),
      ]);
      if (id !== request.current) return;
      const paths = new Map(fileList.map((f) => [f.id, f.path]));
      setComments(list.map((c) => ({ ...c, path: paths.get(c.file) ?? null })));
      setFiles(fileList);
      setRole(summary.role);
    } catch (cause) {
      if (id === request.current) setError(String(cause instanceof Error ? cause.message : cause));
    }
  }, [link]);
  useEffect(() => {
    if (!link) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const focused = () => void refresh();
    window.addEventListener("focus", focused);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focused);
    };
  }, [link, refresh]);
  const act = async (method: string, path: string, body?: unknown) => {
    if (!link) return;
    setBusy(true);
    setError(null);
    try {
      await serverRequest(
        link.server,
        method,
        `/api/projects/${encodeURIComponent(link.project)}${path}`,
        body,
      );
      await refresh();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  };
  const share = async (draft: AnnotationDraft) => {
    if (!link || !projectPath) return;
    const payload = await teamPayload(projectPath, draft, files);
    await act("POST", "/comments", payload);
  };
  return (
    <TeamContext.Provider
      value={{
        link,
        comments,
        me,
        role,
        busy,
        error,
        setError,
        open,
        setOpen,
        focus,
        setFocus,
        refresh,
        act,
        share,
      }}
    >
      {children}
    </TeamContext.Provider>
  );
}

/**
 * The server request for a desktop draft. A text selection gives its offsets; a PDF selection
 * is mapped with SyncTeX on this computer's PDF and found in the source like the web does.
 * The server checks the excerpt, so a folder that is not yet synced is refused, not misplaced.
 */
async function teamPayload(projectPath: string, draft: AnnotationDraft, files: ServerFile[]) {
  const serverFile = (path: string) => {
    const found = files.find((f) => f.path === path && !f.binary);
    if (!found) throw new Error(path);
    return found.id;
  };
  if (draft.kind === "text") {
    const range = draft.ranges?.[0];
    if (!draft.file || !range) throw new Error("no selection");
    return {
      file: serverFile(draft.file),
      from: range.start,
      to: range.end,
      excerpt: range.text,
      quote: draft.quote,
      body: draft.comment,
    };
  }
  const pdfPath = pathSync.join(projectPath, draft.pdf);
  const ends = [draft.marks[0], draft.marks.at(-1)];
  const [start, end] = await Promise.all(
    ends.map((mark) => {
      if (!mark) throw new Error("no selection");
      return invoke<SynctexResult>("latex_synctex_edit", {
        pdfPath,
        page: mark.page,
        x: (mark.x + mark.width / 2) * mark.pageWidth,
        y: (mark.y + mark.height / 2) * mark.pageHeight,
      });
    }),
  );
  if (!start || !end) throw new Error("no selection");
  const relative = (file: string) => {
    const normal = file.replace(/\\/g, "/").replace(/\/\.\//g, "/");
    const root = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
    return normal.startsWith(`${root}/`) ? normal.slice(root.length + 1) : normal;
  };
  const path = relative(start.file);
  const content = await invoke<string>("read_file", { path: pathSync.join(projectPath, path) });
  const last = relative(end.file) === path && end.line >= start.line ? end.line : start.line;
  const { from, to } = locateQuote(content, draft.quote, start.line, last);
  return {
    file: serverFile(path),
    from,
    to,
    excerpt: content.slice(from, to),
    quote: draft.quote,
    body: draft.comment,
    pdf: {
      fingerprint: draft.fingerprint,
      style: draft.style,
      marks: draft.marks.map(({ page, x, y, width, height }) => ({ page, x, y, width, height })),
    },
  };
}
