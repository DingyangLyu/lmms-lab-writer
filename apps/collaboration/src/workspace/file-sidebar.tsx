import { isTextPath } from "@lmms-lab/sync";
import { type ChangeEvent, useEffect, useRef } from "react";
import { api, base64 } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";

const SKIPPED = ["node_modules", "target", "build", "dist"];

export function FileSidebar({ ws, memberCount }: { ws: WorkspaceContext; memberCount: number }) {
  const { t } = useI18n();
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
        const text = isTextPath(path);
        if (input.size > (text ? 2_000_000 : 10_000_000))
          throw new Error(t("files.tooLarge", { path, count }));
        await api(`${prefix}/files`, {
          path,
          ...(text
            ? { content: await input.text() }
            : { base64: base64(new Uint8Array(await input.arrayBuffer())) }),
        });
        count++;
      }
      await reload();
      ws.notify(t("files.imported", { count }));
    });
  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    upload(e.target.files);
    e.target.value = "";
  };
  return (
    <aside className="file-sidebar">
      <div className="pane-heading">{t("files.title")}</div>
      <div className="file-actions">
        <button type="button" disabled={!canEdit || busy} onClick={() => imports.current?.click()}>
          {t("files.upload")}
        </button>
        <button type="button" disabled={!canEdit || busy} onClick={() => folder.current?.click()}>
          {t("files.importFolder")}
        </button>
        <button
          type="button"
          disabled={!canEdit || busy}
          onClick={() => {
            const path = prompt(t("files.newPrompt"));
            if (path)
              run(async () => {
                await api(`${prefix}/files`, { path, content: "" });
                await reload();
              });
          }}
        >
          {t("files.new")}
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
                  title={t("files.renameTitle")}
                  aria-label={t("files.renameLabel", { path: f.path })}
                  disabled={busy}
                  onClick={() => {
                    const next = prompt(t("files.renamePrompt"), f.path);
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
                  title={t("files.deleteTitle")}
                  aria-label={t("files.deleteLabel", { path: f.path })}
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t("files.deleteConfirm", { path: f.path })))
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
        {t("files.footer", { files: files.length, members: memberCount })}
      </p>
    </aside>
  );
}
