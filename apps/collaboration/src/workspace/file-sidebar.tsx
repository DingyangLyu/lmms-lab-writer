import { type ChangeEvent, useEffect, useRef } from "react";
import { api, base64 } from "../api";
import type { WorkspaceContext } from "./context";

const TEXT = ["tex", "bib", "md", "txt", "sty", "cls", "bst", "csv", "json", "py", "yaml", "yml"];
const SKIPPED = ["node_modules", "target", "build", "dist"];

export function FileSidebar({ ws, memberCount }: { ws: WorkspaceContext; memberCount: number }) {
  const imports = useRef<HTMLInputElement>(null),
    folder = useRef<HTMLInputElement>(null);
  useEffect(() => {
    folder.current?.setAttribute("webkitdirectory", "");
  }, []);
  const { prefix, files, file, canEdit, busy, run, reload } = ws;
  const upload = (selected: FileList | null) =>
    run(async () => {
      if (!selected) return;
      let count = 0;
      for (const input of Array.from(selected)) {
        let path = input.webkitRelativePath || input.name;
        if (input.webkitRelativePath) path = path.split("/").slice(1).join("/");
        if (path.split("/").some((p) => p.startsWith(".") || SKIPPED.includes(p))) continue;
        const text = TEXT.includes(path.split(".").pop()?.toLowerCase() || "");
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
      ws.notify(`已导入 ${count} 个文件。`);
    });
  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    upload(e.target.files);
    e.target.value = "";
  };
  return (
    <aside className="file-sidebar">
      <div className="pane-heading">项目文件</div>
      <div className="file-actions">
        <button type="button" disabled={!canEdit || busy} onClick={() => imports.current?.click()}>
          上传文件
        </button>
        <button type="button" disabled={!canEdit || busy} onClick={() => folder.current?.click()}>
          导入文件夹
        </button>
        <button
          type="button"
          disabled={!canEdit || busy}
          onClick={() => {
            const path = prompt("新文件相对路径，例如 main.tex");
            if (path)
              run(async () => {
                await api(`${prefix}/files`, { path, content: "" });
                await reload();
              });
          }}
        >
          新建
        </button>
      </div>
      <input ref={imports} type="file" multiple hidden onChange={picked} />
      <input ref={folder} type="file" multiple hidden onChange={picked} />
      <nav>
        {files.map((f) => (
          <div className={`file-row ${file?.id === f.id ? "active" : ""}`} key={f.id}>
            <button type="button" title={f.path} className="file" onClick={() => ws.openFile(f)}>
              {f.path}
            </button>
            {canEdit && (
              <span className="file-actions-inline">
                <button
                  type="button"
                  title="重命名或移动"
                  aria-label={`重命名 ${f.path}`}
                  disabled={busy}
                  onClick={() => {
                    const next = prompt(
                      "新的相对路径（可含文件夹，例如 sections/intro.tex）",
                      f.path,
                    );
                    if (next && next !== f.path)
                      run(async () => {
                        await api(`${prefix}/files/${f.id}`, { path: next.trim() }, "PATCH");
                        await reload();
                      });
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  title="删除"
                  aria-label={`删除 ${f.path}`}
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`删除 ${f.path}？删除前会自动保存一个项目版本。`))
                      run(async () => {
                        await api(`${prefix}/files/${f.id}`, {}, "DELETE");
                        await reload();
                      });
                  }}
                >
                  ×
                </button>
              </span>
            )}
          </div>
        ))}
      </nav>
      <p className="muted sidebar-foot">
        {files.length} 个文件 · {memberCount} 位成员
      </p>
    </aside>
  );
}
