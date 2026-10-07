import { parseBib } from "@lmms-lab/writing";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FileInfo, ProjectSummary, PublicUser, Role } from "../../shared/api";
import { download } from "../api";
import { Editor, type EditorHandle, type Selection } from "../editor";
import { roleName, statusName } from "../labels";
import { projectHints } from "../latex-completion";
import type { SyncStatus } from "../provider";
import { TasksPanel } from "../tasks";
import { useAction } from "../use-action";
import { BibliographyTab } from "./bibliography-tab";
import { BinaryPreview } from "./binary-preview";
import { BuildControls, BuildPane, useBuild } from "./build";
import { CommentsTab } from "./comments-tab";
import type { WorkspaceContext } from "./context";
import { FileSidebar } from "./file-sidebar";
import { HistoryTab } from "./history-tab";
import { MembersTab } from "./members-tab";
import { ReviewTab } from "./review-tab";
import { useProject } from "./use-project";

const TABS = [
  ["comments", "批注"],
  ["bibliography", "文献"],
  ["review", "审阅"],
  ["history", "版本"],
  ["members", "成员"],
  ["tasks", "任务"],
] as const;
type Tab = (typeof TABS)[number][0];

/** The comment being written survives reloads (stored per user and project). */
function useCommentDraft(key: string, report: (message: string) => void) {
  const [draft, setDraft] = useState(""),
    [selection, setSelection] = useState<Selection | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved) {
        setDraft(saved.body || "");
        setSelection(saved.selection || null);
      }
    } catch {}
  }, [key]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ body: draft, selection }));
    } catch {
      report("批注草稿未能保存到本机，请提交后再关闭。");
    }
  }, [draft, selection, key, report]);
  return { draft, setDraft, selection, setSelection };
}

export function Workspace({
  project,
  user,
  onBack,
}: {
  project: ProjectSummary;
  user: PublicUser;
  onBack: () => void;
}) {
  const prefix = `/projects/${project.id}`;
  const [role, setRole] = useState<Role>(project.role),
    [status, setStatus] = useState<SyncStatus>("connecting"),
    [tab, setTab] = useState<Tab>("comments"),
    [notice, setNotice] = useState(""),
    [file, setFile] = useState<FileInfo | null>(null);
  const { busy, error, setError, run } = useAction();
  const data = useProject(prefix, { onRole: setRole, onError: setError });
  const editor = useRef<EditorHandle | null>(null);
  const comment = useCommentDraft(`writer-note-draft:${user.id}:${project.id}`, setError);
  // Keep the open file in step with the list (renames, deletions, first load).
  useEffect(() => {
    setFile((old) =>
      old
        ? (data.files.find((f) => f.id === old.id) ?? null)
        : (data.files.find((f) => f.path.endsWith(".tex")) ?? data.files[0] ?? null),
    );
  }, [data.files]);
  const hints = useMemo(() => projectHints(data.sources, parseBib), [data.sources]);
  const hintsRef = useRef(hints);
  hintsRef.current = hints;
  const ws: WorkspaceContext = {
    prefix,
    project,
    user,
    role,
    canEdit: role === "owner" || role === "editor",
    canComment: role !== "viewer",
    busy,
    run,
    reload: data.reload,
    notify: setNotice,
    report: setError,
    editor,
    file,
    files: data.files,
    openFile: (next) => {
      setFile(next);
      comment.setSelection(null);
    },
    status,
  };
  const b = useBuild(ws, data.latestBuild, data.sources);
  return (
    <div className="workspace">
      <header className="workspace-header">
        <div className="row">
          <button type="button" onClick={onBack}>
            ← 项目
          </button>
          <strong>{project.name}</strong>
          <span className="badge">{roleName[role]}</span>
        </div>
        <div className="row">
          <span className={`save-state ${status}`}>
            {file && !file.binary ? statusName[status] : "文件预览"}
          </span>
          <span className="username">{user.name}</span>
          <a href={`/api${prefix}/export`}>导出项目</a>
        </div>
      </header>
      {(error || notice) && (
        <div role={error ? "alert" : "status"} className={error ? "banner error" : "banner"}>
          {error || notice}
          <button
            type="button"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            ×
          </button>
        </div>
      )}
      <div className="workspace-body">
        <FileSidebar ws={ws} memberCount={data.members.length} />
        <main className="document">
          <div className="document-toolbar">
            <strong>{file?.path || "导入或创建第一份文稿"}</strong>
            <BuildControls ws={ws} b={b} />
            {file && !file.binary && (
              <div className="row">
                <button
                  type="button"
                  disabled={!ws.canComment}
                  onClick={() => {
                    const s = editor.current?.selection();
                    if (!s) {
                      setError("请先在正文中选中文字。");
                      return;
                    }
                    comment.setSelection(s);
                    setTab("comments");
                  }}
                >
                  批注所选文字
                </button>
                <button
                  type="button"
                  onClick={() =>
                    download(
                      file.path.split("/").pop() || "recovery.tex",
                      new Blob([editor.current?.text() || ""], {
                        type: "text/plain;charset=utf-8",
                      }),
                    )
                  }
                >
                  导出当前文字
                </button>
              </div>
            )}
          </div>
          <div className="document-panes">
            <div className="editor-pane">
              {file ? (
                file.binary ? (
                  <BinaryPreview key={file.id} prefix={prefix} file={file} />
                ) : (
                  <Editor
                    key={file.id}
                    project={project.id}
                    file={file.id}
                    user={user}
                    role={role}
                    comments={data.comments}
                    onRole={setRole}
                    onStatus={setStatus}
                    onError={setError}
                    onReady={(handle) => {
                      editor.current = handle;
                    }}
                    hints={() => hintsRef.current}
                  />
                )
              ) : (
                <div className="empty">
                  <h2>开始一起写作</h2>
                  <p>导入完整 LaTeX 文件夹，或创建 main.tex。</p>
                </div>
              )}
            </div>
            {b.open && <BuildPane prefix={prefix} b={b} />}
          </div>
        </main>
        <aside className="inspector">
          <nav className="tabs">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={tab === id ? "selected" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="inspector-content">
            {tab === "comments" && <CommentsTab ws={ws} comments={data.comments} {...comment} />}
            {tab === "bibliography" && (
              <BibliographyTab
                ws={ws}
                sources={data.sources}
                refreshSources={data.refreshSources}
              />
            )}
            {tab === "review" && <ReviewTab key={file?.id} ws={ws} proposals={data.proposals} />}
            {tab === "history" && <HistoryTab ws={ws} snapshots={data.snapshots} />}
            {tab === "tasks" && (
              <TasksPanel
                project={project.id}
                role={role}
                jobs={data.jobs}
                currentFile={file?.path}
                reload={data.reload}
                onError={setError}
              />
            )}
            {tab === "members" && <MembersTab ws={ws} members={data.members} onDeleted={onBack} />}
          </div>
        </aside>
      </div>
    </div>
  );
}
