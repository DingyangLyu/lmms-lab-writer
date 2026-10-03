import { type DocumentConflict, mergeText, type SaveResult } from "./merge";
export type Draft = {
  project: string;
  path: string;
  content: string;
  base: string;
  localConflict?: DocumentConflict | null;
};
export type DocumentSave = Draft & {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  draftError: string | null;
  recovered: boolean;
  revision: number;
  conflict?: DocumentConflict | null;
  syncRun?: Promise<void>;
  mergeNotice?: string;
  timer?: ReturnType<typeof setTimeout>;
  persistTimer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const PREFIX = "writer-draft-v1:";
/** Above this size, serializing the recovery draft on every keystroke stalls typing. */
const LARGE_DRAFT_CHARS = 200_000;
export const documentKey = (project: string, path: string) => JSON.stringify([project, path]);

/** Each document owns its debounce and serial write queue, independently of mounted tabs. */
export class SaveManager {
  readonly documents = new Map<string, DocumentSave>();
  private listeners = new Set<() => void>();
  constructor(
    // biome-ignore lint/suspicious/noConfusingVoidType: Supports legacy write callbacks that return Promise<void>.
    private write: (draft: Draft) => Promise<void | SaveResult>,
    private storage: Storage,
    private delay = 500,
    private read?: (project: string, path: string) => Promise<string>,
  ) {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }
  get(project: string, path: string) {
    return this.documents.get(documentKey(project, path));
  }
  open(project: string, path: string, disk: string): string {
    const existing = this.get(project, path);
    if (existing?.dirty || existing?.saving) return existing.content;
    let draft: Draft | null = null;
    let draftError: string | null = null;
    try {
      const raw = this.storage.getItem(PREFIX + documentKey(project, path));
      if (raw) {
        const value = JSON.parse(raw) as Partial<Draft>;
        if (
          value.project === project &&
          value.path === path &&
          typeof value.content === "string" &&
          typeof value.base === "string"
        ) {
          draft = value as Draft;
        }
      }
    } catch {
      draftError = "无法读取本地恢复草稿。请保持应用打开并保存文件。";
    }
    const recovered = draft !== null && draft.content !== disk;
    const doc: DocumentSave = {
      project,
      path,
      content: recovered && draft ? draft.content : disk,
      base: recovered && draft ? draft.base : disk,
      dirty: recovered,
      saving: false,
      error: null,
      draftError,
      recovered,
      revision: 0,
      localConflict: draft?.localConflict,
      conflict: draft?.localConflict,
    };
    this.documents.set(documentKey(project, path), doc);
    this.changed();
    return doc.content;
  }
  async recoverProject(project: string, read: (path: string) => Promise<string>): Promise<void> {
    const drafts: Draft[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const raw = this.storage.getItem(key);
      if (!raw) continue;
      try {
        const draft = JSON.parse(raw) as Draft;
        if (
          draft.project === project &&
          typeof draft.path === "string" &&
          typeof draft.content === "string" &&
          typeof draft.base === "string"
        )
          drafts.push(draft);
      } catch {
        /* Ignore unrelated malformed storage records. */
      }
    }
    for (const draft of drafts) {
      const disk = await read(draft.path).catch(() => draft.base);
      this.open(project, draft.path, disk);
    }
  }

  edit(project: string, path: string, content: string, editorBase?: string) {
    const doc = this.get(project, path);
    if (!doc) throw new Error("文件尚未读取，不能保存。请重新打开文件。");
    if (content === doc.content) return;
    if (doc.localConflict) {
      const merged = mergeText(doc.localConflict.base, content, doc.localConflict.theirs);
      if (merged.content !== null) {
        content = merged.content;
        doc.localConflict = null;
        doc.conflict = null;
      } else {
        doc.localConflict = {
          ...doc.localConflict,
          ours: content,
          parts: merged.parts,
          updatedAt: Date.now(),
        };
        doc.conflict = doc.localConflict;
      }
    }
    if (editorBase !== undefined && editorBase !== doc.content && !doc.localConflict) {
      const merged = mergeText(editorBase, content, doc.content);
      if (merged.content !== null) content = merged.content;
      else {
        doc.localConflict = {
          id: `local:${documentKey(project, path)}`,
          path,
          owner: "editor",
          base: editorBase,
          ours: content,
          theirs: doc.content,
          disk: doc.base,
          parts: merged.parts,
          updatedAt: Date.now(),
          status: "pending",
          local: true,
        };
        doc.conflict = doc.localConflict;
      }
    }
    doc.content = content;
    doc.revision++;
    doc.dirty = content !== doc.base || doc.saving;
    doc.error = null;
    if (content.length + doc.base.length > LARGE_DRAFT_CHARS) this.persistSoon(doc);
    else this.persist(doc);
    if (doc.timer) clearTimeout(doc.timer);
    doc.timer = setTimeout(() => {
      void this.flushDocument(doc).catch(() => {});
    }, this.delay);
    this.changed();
  }
  private persistSoon(doc: DocumentSave) {
    doc.persistTimer ??= setTimeout(() => {
      doc.persistTimer = undefined;
      if (doc.dirty || doc.localConflict) this.persist(doc);
    }, 250);
  }
  private persist(doc: DocumentSave) {
    if (doc.persistTimer) {
      clearTimeout(doc.persistTimer);
      doc.persistTimer = undefined;
    }
    try {
      this.storage.setItem(
        PREFIX + documentKey(doc.project, doc.path),
        JSON.stringify({
          project: doc.project,
          path: doc.path,
          content: doc.content,
          base: doc.base,
          localConflict: doc.localConflict,
        } satisfies Draft),
      );
      doc.draftError = null;
    } catch {
      doc.draftError =
        "本地恢复草稿写入失败（存储空间可能不足）。请立即保存或另存副本，保持应用打开。";
    }
  }
  async flushDocument(doc: DocumentSave): Promise<void> {
    if (doc.timer) {
      clearTimeout(doc.timer);
      doc.timer = undefined;
    }
    if (doc.running) {
      await doc.running;
      if (doc.dirty) return this.flushDocument(doc);
      return;
    }
    if (!doc.dirty) return;
    if (doc.localConflict) {
      doc.error = "编辑器两处修改存在冲突，请在冲突面板中合并；双方草稿已保留。";
      this.changed();
      throw new Error(doc.error);
    }
    doc.saving = true;
    doc.error = null;
    const run = async () => {
      try {
        while (doc.dirty) {
          if (doc.localConflict) throw new Error("编辑器修改存在冲突，请打开冲突面板。");
          const revision = doc.revision;
          const content = doc.content;
          const result = await this.write({
            project: doc.project,
            path: doc.path,
            content,
            base: doc.base,
          });
          if (result?.status === "conflict") {
            if (doc.revision !== revision && !doc.localConflict) continue;
            doc.conflict = result.conflict;
            throw new Error("发现重叠修改，双方内容已保留，请打开“冲突”合并。");
          }
          const saved = result?.content ?? content;
          doc.conflict = null;
          doc.recovered = false;
          doc.dirty = doc.revision !== revision;
          if (doc.dirty) {
            // Keep the branch the in-flight UI edits were based on. The next save
            // merges them onto the actual saved result, including external edits.
            if (!doc.localConflict) doc.base = content;
          } else {
            doc.base = saved;
            doc.content = saved;
          }
          if (result?.merged) doc.mergeNotice = "已自动合并外部修改";
          if (doc.dirty) this.persist(doc);
          else {
            try {
              this.storage.removeItem(PREFIX + documentKey(doc.project, doc.path));
              doc.draftError = null;
            } catch {
              doc.draftError = "文件已保存，但旧恢复草稿清理失败。";
            }
          }
          if (result?.versionError) doc.draftError = result.versionError;
        }
      } catch (error) {
        doc.error = error instanceof Error ? error.message : String(error);
        doc.dirty = true;
        this.persist(doc);
        throw error;
      } finally {
        doc.saving = false;
        this.changed();
      }
    };
    doc.running = run();
    this.changed();
    try {
      await doc.running;
    } finally {
      doc.running = undefined;
    }
  }
  async flushAll(project?: string, paths?: string[]): Promise<void> {
    const results = await Promise.allSettled(
      [...this.documents.values()]
        .filter(
          (doc) => (!project || doc.project === project) && (!paths || paths.includes(doc.path)),
        )
        .map((doc) => this.flushDocument(doc)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  async synchronizeDocument(doc: DocumentSave): Promise<void> {
    if (doc.syncRun) return doc.syncRun;
    const run = async () => {
      if (doc.dirty || doc.running) await this.flushDocument(doc);
      if (!this.read) return;
      const disk = await this.read(doc.project, doc.path);
      if (doc.dirty || doc.running) {
        await this.flushDocument(doc);
        return;
      }
      if (doc.content !== disk) {
        doc.content = disk;
        doc.base = disk;
        doc.revision++;
        this.changed();
      }
    };
    doc.syncRun = run();
    try {
      await doc.syncRun;
    } finally {
      doc.syncRun = undefined;
    }
  }
  async synchronize(project: string, paths?: string[]) {
    const docs = [...this.documents.values()].filter(
      (doc) => doc.project === project && (!paths || paths.includes(doc.path)),
    );
    const results = await Promise.allSettled(docs.map((doc) => this.synchronizeDocument(doc)));
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  async resolveLocal(doc: DocumentSave, content: string, expected: string) {
    if (doc.content !== expected) throw new Error("草稿又有修改，请重新打开冲突面板。");
    doc.localConflict = null;
    doc.conflict = null;
    doc.content = content;
    doc.revision++;
    doc.dirty = true;
    this.persist(doc);
    this.changed();
    await this.flushDocument(doc);
  }
  async acceptResolved(project: string, path: string, content: string, expected?: string) {
    const doc = this.get(project, path);
    if (!doc) return;
    if (doc.timer) clearTimeout(doc.timer);
    doc.error = null;
    doc.conflict = null;
    doc.localConflict = null;
    doc.recovered = false;
    doc.revision++;
    if (expected !== undefined && doc.content !== expected) {
      // A later keystroke is a new branch, never discard it when a review returns.
      doc.base = expected;
      doc.dirty = true;
      this.persist(doc);
      this.changed();
      await this.flushDocument(doc);
      return;
    }
    doc.content = content;
    doc.base = content;
    doc.dirty = false;
    if (doc.persistTimer) clearTimeout(doc.persistTimer);
    doc.persistTimer = undefined;
    try {
      this.storage.removeItem(PREFIX + documentKey(project, path));
    } catch {
      doc.draftError = "文件已保存，但旧恢复草稿清理失败。";
    }
    this.changed();
  }
  /** Explicitly discarding a draft is only called after the user confirms. */
  discard(project: string, path: string, disk: string) {
    const doc = this.get(project, path);
    if (doc?.saving) throw new Error("正在保存，请稍后重试。");
    if (doc?.timer) clearTimeout(doc.timer);
    if (doc?.persistTimer) clearTimeout(doc.persistTimer);
    this.storage.removeItem(PREFIX + documentKey(project, path));
    this.documents.delete(documentKey(project, path));
    this.open(project, path, disk);
  }
}

/** File links from agents can be absolute; use one buffer key per project file. */
export function projectRelativePath(project: string, path: string): string {
  let normalized = path.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (/^file:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^file:\/\//i, "");
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      /* Keep malformed URI for validation. */
    }
  }
  normalized = normalized.replace(/\\/g, "/").replace(/^\/([a-zA-Z]:\/)/, "$1");
  const root = project.replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = /^[a-zA-Z]:/.test(root);
  const candidate = windows ? normalized.toLowerCase() : normalized;
  const prefix = `${windows ? root.toLowerCase() : root}/`;
  return candidate.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized.replace(/^\.\//, "");
}
