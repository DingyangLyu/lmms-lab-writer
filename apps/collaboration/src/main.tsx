import { citations, displayBib, normalizeDoi, parseBib, type ReviewHunk } from "@lmms-lab/writing";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, base64, download, unbase64 } from "./api";
import { type Comment, Editor, type EditorHandle, type Selection } from "./editor";
import type { Person, SyncStatus } from "./provider";
import "./style.css";
import { type SharedJob, TasksPanel } from "./tasks";

type Project = { id: string; name: string; role: string };
type FileInfo = { id: string; path: string; binary: boolean | number; revision: number };
type Proposal = {
  id: string;
  file: string;
  base: string;
  proposed: string;
  hunks: ReviewHunk[];
  revision: number;
  author: string;
};
const roleName: Record<string, string> = {
  owner: "所有者",
  editor: "编辑者",
  commenter: "批注者",
  viewer: "只读",
};
const statusName: Record<SyncStatus, string> = {
  connecting: "正在连接",
  saved: "服务器已保存",
  saving: "正在同步保存",
  offline: "离线 · 草稿留在本机",
  denied: "权限已改变 · 本机草稿保留",
};
function App() {
  const [user, setUser] = useState<Person | null>(null),
    [ready, setReady] = useState(false),
    [project, setProject] = useState<Project | null>(null),
    [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState("");
  const [invite] = useState(() => new URL(location.href).searchParams.get("invite"));
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const reload = useCallback(async () => setProjects(await api<Project[]>("/projects")), []);
  useEffect(() => {
    void api<Person>("/me")
      .then(setUser)
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (user) void reload().catch((e) => setError(String(e)));
  }, [user, reload]);
  if (!ready)
    return (
      <div className="auth">
        <h1>Writer</h1>
        <p>正在载入…</p>
      </div>
    );
  if (!user || invite)
    return (
      <div className="auth">
        <span className="eyebrow">WRITER / COLLABORATION</span>
        <h1>{invite ? "加入写作项目" : "共同写作"}</h1>
        <p>与合作者编辑同一份文稿，保留每次讨论和修改。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const me = await api<Person>(invite ? "/join" : "/login", {
                username,
                password,
                ...(invite ? { token: invite } : {}),
              });
              setUser(me);
              setPassword("");
              if (invite) {
                history.replaceState(null, "", "/");
                location.reload();
              }
            });
          }}
        >
          <label>
            用户名
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete={invite ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={12}
              required
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "处理中…" : invite ? "加入项目" : "登录"}
          </button>
        </form>
        <p className="muted">账号和文件保存在你部署的 Writer 服务中。</p>
      </div>
    );
  if (project)
    return (
      <Workspace
        project={project}
        user={user}
        onBack={() => {
          setProject(null);
          void reload();
        }}
      />
    );
  return (
    <main className="dashboard">
      <header>
        <div>
          <span className="eyebrow">WRITER / WORKSPACE</span>
          <h1>我的论文</h1>
        </div>
        <div className="row">
          <span>{user.name}</span>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                await api("/logout", {});
                setUser(null);
              })
            }
          >
            退出登录
          </button>
        </div>
      </header>
      <form
        className="new-project row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const p = await api<Project>("/projects", { name });
            setProject(p);
            setName("");
          });
        }}
      >
        <input
          aria-label="新项目名称"
          placeholder="新项目名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button className="primary" disabled={busy} type="submit">
          创建项目
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="projects">
        {projects.map((p) => (
          <button className="project-card" key={p.id} type="button" onClick={() => setProject(p)}>
            <span className="eyebrow">{roleName[p.role]}</span>
            <h2>{p.name}</h2>
            <span className="muted">打开文稿 →</span>
          </button>
        ))}
      </div>
      {!projects.length && <p className="muted">创建项目，或打开合作者发来的邀请链接。</p>}
    </main>
  );
}
function Workspace({
  project,
  user,
  onBack,
}: {
  project: Project;
  user: Person;
  onBack: () => void;
}) {
  const [files, setFiles] = useState<FileInfo[]>([]),
    [file, setFile] = useState<FileInfo | null>(null),
    [role, setRole] = useState(project.role),
    [status, setStatus] = useState<SyncStatus>("connecting");
  const [tab, setTab] = useState("comments"),
    [comments, setComments] = useState<Comment[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<{ id: string; username: string; role: string }[]>([]),
    [snapshots, setSnapshots] = useState<
      { id: string; label: string; created: number; manual?: boolean }[]
    >([]),
    [proposals, setProposals] = useState<Proposal[]>([]);
  const [jobs, setJobs] = useState<SharedJob[]>([]);
  const editor = useRef<EditorHandle | null>(null),
    imports = useRef<HTMLInputElement>(null),
    folder = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(""),
    [selection, setSelection] = useState<Selection | null>(null),
    [reply, setReply] = useState<Record<string, string>>({}),
    [inviteRole, setInviteRole] = useState("editor"),
    [inviteLink, setInviteLink] = useState("");
  const [sources, setSources] = useState<{ id: string; path: string; content: string }[]>([]),
    [search, setSearch] = useState(""),
    [doi, setDoi] = useState(""),
    [bib, setBib] = useState(""),
    [bibFile, setBibFile] = useState("");
  const [proposal, setProposal] = useState(""),
    [snapshotLabel, setSnapshotLabel] = useState("");
  const prefix = `/projects/${project.id}`,
    canEdit = ["owner", "editor"].includes(role),
    canComment = role !== "viewer";
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const reload = useCallback(async () => {
    const [f, c, m, s, p, j] = await Promise.all([
      api<FileInfo[]>(`${prefix}/files`),
      api<Comment[]>(`${prefix}/comments`),
      api<typeof members>(`${prefix}/members`),
      api<typeof snapshots>(`${prefix}/snapshots`),
      api<Proposal[]>(`${prefix}/proposals`),
      api<SharedJob[]>(`${prefix}/jobs`),
    ]);
    setFiles(f);
    setComments(c);
    setMembers(m);
    setSnapshots(s);
    setProposals(p);
    setJobs(j);
    setFile((old) =>
      old
        ? (f.find((item) => item.id === old.id) ?? null)
        : (f.find((item) => item.path.endsWith(".tex")) ?? f[0] ?? null),
    );
  }, [prefix]);
  useEffect(() => {
    let socket: WebSocket | null = null,
      stopped = false,
      retry: ReturnType<typeof setTimeout> | null = null;
    // Bursts of project-changed events collapse into one reload at a time, so an older
    // response can never overwrite a newer one.
    let loading = false,
      again = false;
    const refresh = () => {
      if (loading) {
        again = true;
        return;
      }
      loading = true;
      void reload()
        .catch((e) => setError(String(e)))
        .finally(() => {
          loading = false;
          if (again && !stopped) {
            again = false;
            refresh();
          }
        });
    };
    refresh();
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api${prefix}/socket`,
      );
      socket.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "project-changed") refresh();
        if (m.type === "ready") setRole(m.role);
      };
      socket.onclose = (e) => {
        if (!stopped && e.code !== 1008) retry = setTimeout(connect, 1500);
        else if (!stopped) {
          setRole("viewer");
          setError("项目权限已变更，请返回项目列表重新进入。");
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      socket?.close();
      if (retry) clearTimeout(retry);
    };
  }, [prefix, reload]);
  useEffect(() => {
    if (tab === "bibliography")
      void api<typeof sources>(`${prefix}/sources`)
        .then((s) => {
          setSources(s);
          setBibFile((old) => old || s.find((f) => f.path.endsWith(".bib"))?.id || "");
        })
        .catch((e) => setError(String(e)));
  }, [prefix, tab]);
  useEffect(() => {
    folder.current?.setAttribute("webkitdirectory", "");
  }, []);
  const saveDraftKey = `writer-note-draft:${user.id}:${project.id}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(saveDraftKey) || "null");
      if (saved) {
        setDraft(saved.body || "");
        setSelection(saved.selection || null);
      }
    } catch {}
  }, [saveDraftKey]);
  useEffect(() => {
    try {
      localStorage.setItem(saveDraftKey, JSON.stringify({ body: draft, selection }));
    } catch {
      setError("批注草稿未能保存到本机，请提交后再关闭。");
    }
  }, [draft, selection, saveDraftKey]);
  const upload = async (selected: FileList | null) => {
    if (!selected) return;
    let count = 0;
    for (const input of Array.from(selected)) {
      let path = input.webkitRelativePath || input.name;
      if (input.webkitRelativePath) path = path.split("/").slice(1).join("/");
      if (
        path
          .split("/")
          .some((p) => p.startsWith(".") || ["node_modules", "target", "build", "dist"].includes(p))
      )
        continue;
      const ext = path.split(".").pop()?.toLowerCase() || "",
        text = [
          "tex",
          "bib",
          "md",
          "txt",
          "sty",
          "cls",
          "bst",
          "csv",
          "json",
          "py",
          "yaml",
          "yml",
        ].includes(ext);
      if (input.size > (text ? 2_000_000 : 10_000_000))
        throw new Error(`${path} 太大，已导入 ${count} 个文件。`);
      await api(`${prefix}/files`, {
        path,
        ...(text
          ? { content: await input.text() }
          : { base64: base64(new Uint8Array(await input.arrayBuffer())) }),
      });
      count++;
    }
    await reload();
    setNotice(`已导入 ${count} 个文件。`);
  };
  const entries = sources
    .filter((f) => f.path.endsWith(".bib"))
    .flatMap((f) => parseBib(f.content).entries.map((e) => ({ ...e, file: f.id })));
  const sourcesChanged = async () => setSources(await api<typeof sources>(`${prefix}/sources`));
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
        <aside className="file-sidebar">
          <div className="pane-heading">项目文件</div>
          <div className="file-actions">
            <button
              type="button"
              disabled={!canEdit || busy}
              onClick={() => imports.current?.click()}
            >
              上传文件
            </button>
            <button
              type="button"
              disabled={!canEdit || busy}
              onClick={() => folder.current?.click()}
            >
              导入文件夹
            </button>
            <button
              type="button"
              disabled={!canEdit || busy}
              onClick={() => {
                const path = prompt("新文件相对路径，例如 main.tex");
                if (path)
                  void run(async () => {
                    await api(`${prefix}/files`, { path, content: "" });
                    await reload();
                  });
              }}
            >
              新建
            </button>
          </div>
          <input
            ref={imports}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void run(() => upload(e.target.files));
              e.target.value = "";
            }}
          />
          <input
            ref={folder}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void run(() => upload(e.target.files));
              e.target.value = "";
            }}
          />
          <nav>
            {files.map((f) => (
              <button
                type="button"
                title={f.path}
                key={f.id}
                className={`file ${file?.id === f.id ? "active" : ""}`}
                onClick={() => {
                  setFile(f);
                  setSelection(null);
                  setProposal("");
                }}
              >
                {f.path}
              </button>
            ))}
          </nav>
          <p className="muted sidebar-foot">
            {files.length} 个文件 · {members.length} 位成员
          </p>
        </aside>
        <main className="document">
          <div className="document-toolbar">
            <strong>{file?.path || "导入或创建第一份文稿"}</strong>
            {file && !file.binary && (
              <div className="row">
                <button
                  type="button"
                  disabled={!canComment}
                  onClick={() => {
                    const s = editor.current?.selection();
                    if (!s) {
                      setError("请先在正文中选中文字。");
                      return;
                    }
                    setSelection(s);
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
                comments={comments}
                onRole={setRole}
                onStatus={setStatus}
                onError={setError}
                onReady={(handle) => {
                  editor.current = handle;
                }}
              />
            )
          ) : (
            <div className="empty">
              <h2>开始一起写作</h2>
              <p>导入完整 LaTeX 文件夹，或创建 main.tex。</p>
            </div>
          )}
        </main>
        <aside className="inspector">
          <nav className="tabs">
            {[
              ["comments", "批注"],
              ["bibliography", "文献"],
              ["review", "审阅"],
              ["history", "版本"],
              ["members", "成员"],
              ["tasks", "任务"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={tab === id ? "selected" : ""}
                onClick={() => setTab(id || "comments")}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="inspector-content">
            {tab === "comments" && (
              <>
                <h2>讨论与批注</h2>
                {selection && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!file) return;
                      void run(async () => {
                        await api(`${prefix}/comments`, {
                          file: file.id,
                          ...selection,
                          body: draft,
                        });
                        setDraft("");
                        setSelection(null);
                        await reload();
                      });
                    }}
                  >
                    <blockquote>{selection.quote}</blockquote>
                    <textarea
                      aria-label="批注内容"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="提出修改建议…"
                      required
                    />
                    <div className="row">
                      <button
                        type="submit"
                        className="primary"
                        disabled={busy || !canComment || status !== "saved"}
                      >
                        发布批注
                      </button>
                      <button type="button" onClick={() => setSelection(null)}>
                        收起
                      </button>
                    </div>
                  </form>
                )}
                {comments.map((c) => (
                  <details
                    key={c.id}
                    className={`comment ${c.resolved ? "resolved" : ""}`}
                    open={!c.resolved}
                  >
                    <summary>
                      <span>{c.resolved ? "✓ 已解决" : "待处理"}</span> · {c.authorName}
                    </summary>
                    <blockquote>{c.quote}</blockquote>
                    <p>{c.body}</p>
                    <div className="row">
                      <button
                        type="button"
                        onClick={() => {
                          const target = files.find((f) => f.id === c.file);
                          if (target && file?.id !== target.id) {
                            setFile(target);
                            setNotice("已打开批注文档，再点“定位”跳转。");
                          } else editor.current?.focusComment(c);
                        }}
                      >
                        定位
                      </button>
                      <button
                        type="button"
                        disabled={busy || !canComment}
                        onClick={() =>
                          void run(async () => {
                            await api(
                              `${prefix}/comments/${c.id}`,
                              { resolved: !c.resolved },
                              "PATCH",
                            );
                            await reload();
                          })
                        }
                      >
                        {c.resolved ? "重新打开" : "标为已解决"}
                      </button>
                    </div>
                    {c.replies.map((r) => (
                      <p className="reply" key={r.id}>
                        <strong>{r.authorName}</strong> {r.body}
                      </p>
                    ))}
                    {canComment && (
                      <form
                        className="row"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(async () => {
                            await api(`${prefix}/comments/${c.id}/reply`, {
                              body: reply[c.id] || "",
                            });
                            setReply({ ...reply, [c.id]: "" });
                            await reload();
                          });
                        }}
                      >
                        <input
                          aria-label="回复批注"
                          value={reply[c.id] || ""}
                          onChange={(e) => setReply({ ...reply, [c.id]: e.target.value })}
                          placeholder="回复…"
                          required
                        />
                        <button type="submit" disabled={busy}>
                          回复
                        </button>
                      </form>
                    )}
                  </details>
                ))}
              </>
            )}
            {tab === "bibliography" && (
              <>
                <h2>项目文献库</h2>
                <input
                  aria-label="搜索文献"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="标题、作者、引用键"
                />
                <div className="row">
                  <input
                    aria-label="查询 DOI"
                    value={doi}
                    onChange={(e) => setDoi(e.target.value)}
                    placeholder="DOI"
                  />
                  <button
                    type="button"
                    disabled={!canEdit || busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{ bibtex: string }>(`${prefix}/doi`, {
                          doi: normalizeDoi(doi),
                        });
                        setBib(result.bibtex);
                      })
                    }
                  >
                    查询
                  </button>
                </div>
                <select
                  aria-label="目标文献库"
                  value={bibFile}
                  onChange={(e) => setBibFile(e.target.value)}
                >
                  <option value="">选择 .bib 文件</option>
                  {sources
                    .filter((f) => f.path.endsWith(".bib"))
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.path}
                      </option>
                    ))}
                </select>
                <textarea
                  aria-label="导入 BibTeX"
                  value={bib}
                  onChange={(e) => setBib(e.target.value)}
                  placeholder="粘贴 BibTeX（也可由 Zotero 导出）"
                />
                <button
                  type="button"
                  disabled={!canEdit || busy || !bibFile || !bib.trim()}
                  onClick={() =>
                    void run(async () => {
                      const current = await api<{ content: string }>(`${prefix}/files/${bibFile}`);
                      const result = await api<{
                        added: number;
                        skipped: string[];
                        renamed: Record<string, string>;
                      }>(`${prefix}/bibliography/import`, {
                        file: bibFile,
                        expected: current.content,
                        bibtex: bib,
                      });
                      const renamed = Object.entries(result.renamed ?? {})
                        .map(([from, to]) => `${from}→${to}`)
                        .join("，");
                      setNotice(
                        `导入 ${result.added} 条，跳过 ${result.skipped.length} 条重复文献${
                          renamed ? `；引用键冲突已改名：${renamed}` : ""
                        }`,
                      );
                      setBib("");
                      await sourcesChanged();
                    })
                  }
                >
                  导入并去重
                </button>
                {entries
                  .filter((e) => JSON.stringify(e).toLowerCase().includes(search.toLowerCase()))
                  .map((e) => {
                    const d = displayBib(e),
                      locations = sources
                        .filter((f) => f.path.endsWith(".tex"))
                        .flatMap((f) =>
                          citations(f.content)
                            .filter((c) => c.key === e.key)
                            .map((c) => ({ ...c, file: f.path })),
                        );
                    return (
                      <article className="bib-entry" key={`${e.file}:${e.from}`}>
                        <strong>{d.title}</strong>
                        <p className="muted">
                          {d.authors} · {d.year}
                        </p>
                        <code>{e.key}</code>
                        <p>{locations.length} 处引用</p>
                        <div className="row">
                          <button
                            type="button"
                            disabled={!canEdit || !!file?.binary}
                            onClick={() => editor.current?.insert(`\\cite{${e.key}}`)}
                          >
                            插入引用
                          </button>
                          <button
                            type="button"
                            disabled={!canEdit || busy}
                            onClick={() => {
                              const to = prompt("新引用键", e.key);
                              if (to && to !== e.key)
                                void run(async () => {
                                  await api(`${prefix}/bibliography/rename`, { from: e.key, to });
                                  await sourcesChanged();
                                });
                            }}
                          >
                            重命名键
                          </button>
                        </div>
                        <details>
                          <summary>引用位置</summary>
                          {locations.map((c) => (
                            <p key={`${c.file}:${c.from}`}>
                              {c.file}:{c.line}
                            </p>
                          ))}
                        </details>
                      </article>
                    );
                  })}
              </>
            )}
            {tab === "review" && (
              <>
                <h2>逐项审阅</h2>
                <p className="muted">
                  这里的建议尚未写入正文。接受后同步给所有编辑者；重叠修改会保留为待处理建议。
                </p>
                {file && !file.binary && canEdit && (
                  <details>
                    <summary>提交修改建议 / AI 修改结果</summary>
                    <textarea
                      aria-label="建议的新正文"
                      value={proposal}
                      onChange={(e) => setProposal(e.target.value)}
                      placeholder="粘贴当前文档修改后的全文"
                    />
                    <button
                      type="button"
                      disabled={busy || !proposal || status !== "saved"}
                      onClick={() =>
                        void run(async () => {
                          await api(`${prefix}/proposals`, {
                            file: file.id,
                            base: editor.current?.text() || "",
                            proposed: proposal,
                          });
                          setProposal("");
                          await reload();
                        })
                      }
                    >
                      生成逐项差异
                    </button>
                  </details>
                )}
                {proposals.map((p) => (
                  <article className="proposal" key={p.id}>
                    <h3>{files.find((f) => f.id === p.file)?.path || p.file}</h3>
                    {p.hunks.map((h, i) => (
                      <details className="hunk" key={h.id} open={h.status === "pending"}>
                        <summary>
                          {h.status === "accepted"
                            ? "✓ 已接受"
                            : h.status === "rejected"
                              ? "已拒绝"
                              : "待审阅"}{" "}
                          · 修改 {i + 1}
                        </summary>
                        <pre className="before">{h.before || "（新增）"}</pre>
                        <pre className="after">{h.after || "（删除）"}</pre>
                        <div className="row">
                          {(["accepted", "rejected", "pending"] as const).map((status) => (
                            <button
                              key={status}
                              type="button"
                              disabled={!canEdit || busy || h.status === status}
                              onClick={() =>
                                void run(async () => {
                                  await api(`${prefix}/proposals/${p.id}/decide`, {
                                    revision: p.revision,
                                    part: i,
                                    status,
                                  });
                                  await reload();
                                })
                              }
                            >
                              {status === "accepted"
                                ? "接受"
                                : status === "rejected"
                                  ? "拒绝"
                                  : "撤销决定"}
                            </button>
                          ))}
                        </div>
                      </details>
                    ))}
                  </article>
                ))}
              </>
            )}
            {tab === "history" && (
              <>
                <h2>版本与恢复</h2>
                <div className="row">
                  <input
                    aria-label="版本名称"
                    value={snapshotLabel}
                    onChange={(e) => setSnapshotLabel(e.target.value)}
                    placeholder="例如：投稿前核对"
                  />
                  <button
                    type="button"
                    disabled={!canEdit || busy || (!!file && !file.binary && status !== "saved")}
                    onClick={() =>
                      void run(async () => {
                        await api(`${prefix}/snapshots`, { label: snapshotLabel || "手动版本" });
                        setSnapshotLabel("");
                        await reload();
                      })
                    }
                  >
                    保存版本
                  </button>
                </div>
                <p className="muted">
                  恢复当前文件会作为一次新的共同编辑同步，恢复前再保存快照。其他文件不会被覆盖。
                </p>
                {snapshots.map((s) => (
                  <article className="snapshot" key={s.id}>
                    <strong>
                      {s.label}
                      {s.manual === false && <span className="muted"> · 自动</span>}
                    </strong>
                    <p>{new Date(s.created).toLocaleString()}</p>
                    <button
                      type="button"
                      disabled={
                        busy || role !== "owner" || !file || !!file.binary || status !== "saved"
                      }
                      onClick={() => {
                        if (
                          !file ||
                          !confirm(
                            `把 ${file.path} 恢复到这个版本？其他人的当前编辑也会看到恢复结果。`,
                          )
                        )
                          return;
                        void run(async () => {
                          await api(`${prefix}/snapshots/${s.id}/restore`, {
                            file: file.id,
                            expected: editor.current?.text() || "",
                          });
                          await reload();
                        });
                      }}
                    >
                      恢复当前文件
                    </button>
                  </article>
                ))}
              </>
            )}
            {tab === "tasks" && (
              <TasksPanel
                project={project.id}
                role={role}
                jobs={jobs}
                currentFile={file?.path}
                reload={reload}
                onError={setError}
              />
            )}
            {tab === "members" && (
              <>
                <h2>项目成员</h2>
                {role === "owner" && (
                  <>
                    <select
                      aria-label="邀请角色"
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                    >
                      <option value="editor">编辑者</option>
                      <option value="commenter">批注者</option>
                      <option value="viewer">只读</option>
                    </select>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await api<{ url: string }>(`${prefix}/invite`, {
                            role: inviteRole,
                          });
                          setInviteLink(result.url);
                        })
                      }
                    >
                      生成 7 天有效的单次邀请
                    </button>
                    {inviteLink && (
                      <label>
                        邀请链接
                        <input readOnly aria-label="邀请链接" value={inviteLink} />
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard.writeText(inviteLink)}
                        >
                          复制链接
                        </button>
                      </label>
                    )}
                  </>
                )}
                {members.map((m) => (
                  <div className="member row" key={m.id}>
                    <span>
                      {m.username} · {roleName[m.role]}
                    </span>
                    {role === "owner" && m.id !== user.id && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`撤销 ${m.username} 的访问权限？`))
                            void run(async () => {
                              await api(`${prefix}/members/${m.id}`, {}, "DELETE");
                              await reload();
                            });
                        }}
                      >
                        移除
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
function BinaryPreview({ prefix, file }: { prefix: string; file: FileInfo }) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const ext = file.path.split(".").pop()?.toLowerCase();
  const image = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext || "");
  useEffect(() => {
    let current = "",
      disposed = false;
    void api<{ base64: string }>(`${prefix}/files/${file.id}`)
      .then((data) => {
        if (disposed) return;
        const type =
          ext === "pdf"
            ? "application/pdf"
            : ext === "svg"
              ? "image/svg+xml"
              : image
                ? `image/${ext === "jpg" ? "jpeg" : ext}`
                : "application/octet-stream";
        current = URL.createObjectURL(new Blob([unbase64(data.base64)], { type }));
        setUrl(current);
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [prefix, file.id, ext, image]);
  return (
    <div className="binary-preview">
      {error && <p className="error">{error}</p>}
      {url && (
        <>
          <a href={url} download={file.path.split("/").pop()}>
            下载 {file.path}
          </a>
          {ext === "pdf" ? (
            <iframe title={file.path} src={url} />
          ) : image ? (
            <img alt={file.path} src={url} />
          ) : (
            <p>此文件可下载后用本机应用打开。</p>
          )}
        </>
      )}
    </div>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
