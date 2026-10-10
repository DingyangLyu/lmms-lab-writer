/**
 * The desktop's Files sidebar over the server's file list. The server stores files only, so a
 * new empty folder exists in this browser until a file is created in it; renaming or deleting a
 * folder applies to every file below it.
 */
import { isTextPath } from "@lmms-lab/sync";
import { type FileOperations, FileSidebarPanel } from "@lmms-lab/workbench";
import type { FileNode } from "@lmms-lab/writer-shared";
import { FolderOpenIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { type ChangeEvent, type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import type { FileContent } from "../../shared/api";
import { api, base64 } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";

const SKIPPED = ["node_modules", "target", "build", "dist"];

/** The flat list of file paths as the nested tree the shared panel draws. */
export function fileTree(paths: string[], folders: string[] = []): FileNode[] {
  const root: FileNode[] = [];
  const dirs = new Map<string, FileNode[]>([["", root]]);
  const folder = (path: string): FileNode[] => {
    const known = dirs.get(path);
    if (known) return known;
    const slash = path.lastIndexOf("/");
    const parent = folder(slash < 0 ? "" : path.slice(0, slash));
    const node: FileNode = {
      name: path.slice(slash + 1),
      path,
      type: "directory",
      children: [],
    };
    parent.push(node);
    dirs.set(path, node.children as FileNode[]);
    return node.children as FileNode[];
  };
  for (const path of folders) folder(path);
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    folder(slash < 0 ? "" : path.slice(0, slash)).push({
      name: path.slice(slash + 1),
      path,
      type: "file",
    });
  }
  const sort = (nodes: FileNode[]) => {
    nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
    );
    for (const node of nodes) if (node.children) sort(node.children);
  };
  sort(root);
  return root;
}

export function FilePanel({
  ws,
  outlinePath,
  outlineSource,
  onOutline,
}: {
  ws: WorkspaceContext;
  outlinePath?: string;
  outlineSource?: string;
  onOutline: (path: string, line: number) => void;
}) {
  const { t } = useI18n();
  const { prefix, files, file, canEdit, run, reload } = ws;
  const [folders, setFolders] = useState<string[]>([]);
  const uploads = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);
  // A folder that has files no longer needs to be remembered.
  useEffect(() => {
    setFolders((list) => list.filter((f) => !files.some((x) => x.path.startsWith(`${f}/`))));
  }, [files]);
  const tree = useMemo(
    () =>
      fileTree(
        files.map((f) => f.path),
        folders,
      ),
    [files, folders],
  );
  const under = (path: string) =>
    files.filter((f) => f.path === path || f.path.startsWith(`${path}/`));
  const operations: FileOperations = {
    createFile: async (path) => {
      if (!isTextPath(path)) throw new Error(t("shell.onlyTextFiles"));
      await api(`${prefix}/files`, { path, content: "" });
      await reload();
    },
    createDirectory: async (path) => {
      setFolders((list) => [...new Set([...list, path])]);
    },
    renamePath: async (from, to) => {
      for (const f of under(from))
        await api(`${prefix}/files/${f.id}`, { path: to + f.path.slice(from.length) }, "PATCH");
      setFolders((list) =>
        list.map((f) => (f === from || f.startsWith(`${from}/`) ? to + f.slice(from.length) : f)),
      );
      await reload();
    },
    deletePath: async (path) => {
      for (const f of under(path)) await api(`${prefix}/files/${f.id}`, {}, "DELETE");
      setFolders((list) => list.filter((f) => f !== path && !f.startsWith(`${path}/`)));
      await reload();
    },
  };
  const upload = (selected: FileList | File[] | null) =>
    run(async () => {
      if (!selected) return;
      let count = 0;
      for (const input of Array.from(selected)) {
        let path = input.webkitRelativePath || input.name;
        if (input.webkitRelativePath) path = path.split("/").slice(1).join("/");
        if (path.split("/").some((p) => p.startsWith(".") || SKIPPED.includes(p))) continue;
        const text = isTextPath(path);
        if (input.size > (text ? 2_000_000 : 100_000_000))
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
  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    upload(event.target.files);
    event.target.value = "";
  };
  // Files dragged in from the computer are uploaded to the project's top folder.
  const [dropping, setDropping] = useState(false);
  const dropped = (event: DragEvent<HTMLDivElement>) => {
    if (!canEdit || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDropping(false);
    const picked = Array.from(event.dataTransfer.items)
      .filter((item) => item.kind === "file" && !item.webkitGetAsEntry?.()?.isDirectory)
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f);
    if (picked.length) upload(picked);
  };
  const action = "p-1 text-muted hover:text-foreground hover:bg-foreground/5 transition-colors";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for the mouse; the upload buttons do the same from the keyboard.
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (!canEdit || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={dropped}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center border-2 border-dashed border-foreground/40 bg-background/85 text-xs">
          {t("files.dropToUpload")}
        </div>
      )}
      <FileSidebarPanel
        projectPath={ws.project.name}
        files={tree}
        selectedFile={file?.path}
        highlightedFile={null}
        onFileSelect={(path) => {
          const target = files.find((f) => f.path === path);
          if (target) ws.openFile(target);
        }}
        onCreateFile={() => {
          const path = prompt(t("files.newPrompt"));
          if (path) run(() => operations.createFile(path.trim()));
        }}
        onCreateDirectory={() => {
          const path = prompt(t("shell.newFolderPrompt"));
          if (path) void operations.createDirectory(path.trim().replace(/\/+$/, ""));
        }}
        onRefreshFiles={reload}
        fileOperations={canEdit ? operations : undefined}
        outlinePath={outlinePath}
        outlineSource={outlineSource}
        readSource={async (path) => {
          const target = files.find((f) => f.path === path);
          if (!target || target.binary) return null;
          const data = await api<FileContent>(`${prefix}/files/${target.id}`);
          return "content" in data ? data.content : null;
        }}
        onOutlineNavigate={onOutline}
        actions={
          canEdit && (
            <>
              <button
                type="button"
                className={action}
                title={t("files.upload")}
                aria-label={t("files.upload")}
                onClick={() => uploads.current?.click()}
              >
                <UploadSimpleIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                className={action}
                title={t("files.importFolder")}
                aria-label={t("files.importFolder")}
                onClick={() => folderInput.current?.click()}
              >
                <FolderOpenIcon className="h-4 w-4" />
              </button>
            </>
          )
        }
      />
      <input ref={uploads} type="file" multiple hidden onChange={picked} />
      <input ref={folderInput} type="file" multiple hidden onChange={picked} />
    </div>
  );
}
