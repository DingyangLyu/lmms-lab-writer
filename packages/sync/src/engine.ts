import { diffChars, diffWordsWithSpace } from "diff";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { conflictCopyPath, isConflictCopy, isTextPath, validPath } from "./paths";
import {
  type ChangeAuthor,
  decideChanges,
  editsFromOperations,
  type ResolvedChange,
  resolveChanges,
  trackEdits,
} from "./tracked";
import {
  type LocalFolder,
  type RemoteFile,
  RequestError,
  type Role,
  type SocketHandle,
  type StateStore,
  type SyncNotice,
  type SyncState,
  type SyncStatus,
  type Transport,
} from "./types";

/** The server's limits: 2 MB of text per document, 100 MB per binary file. */
const TEXT_LIMIT = 2_000_000,
  BINARY_LIMIT = 100_000_000;
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(value: string) {
  const binary = atob(value),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/**
 * A local text file as the shared document holds it: "\n" line endings only. The server keeps
 * no "\r" (editors count "\r\n" as one character and Yjs as two), so a Windows file with "\r\n"
 * that is otherwise unchanged is not a change.
 */
function decode(bytes: Uint8Array) {
  try {
    return decoder.decode(bytes).replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }
}
/** An empty Yjs update is two zero bytes (no structs, no deletions). */
const hasChanges = (update: Uint8Array) => update.length > 2;

/** flush() found files whose local version the server does not have (see the notices). */
export class SyncIncomplete extends Error {
  constructor(readonly paths: string[]) {
    super(`sync incomplete: ${paths.join(", ")}`);
    this.name = "SyncIncomplete";
  }
}

/** One edit of `before`, at its offset there: `remove` characters became `insert`. */
export type TextOperation = { at: number; remove: number; insert: string };
/**
 * Turns `before` into `after` with character-level edits, so concurrent edits elsewhere in the
 * text merge instead of being overwritten by one large replacement. Returns the edits, for
 * recording them as tracked changes (editsFromOperations).
 */
export function applyTextChange(
  text: Y.Text,
  before: string,
  after: string,
  /** Whole words, for tracked changes, as the server records an AI's ("delta", not "delt"). */
  words = false,
): TextOperation[] {
  const parts = words
    ? diffWordsWithSpace(before, after, { timeout: 2000 })
    : diffChars(before, after, { timeout: 2000 });
  if (!parts) {
    // Diff timed out: replace only the region between the common prefix and suffix.
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (
      end < before.length - start &&
      end < after.length - start &&
      before[before.length - 1 - end] === after[after.length - 1 - end]
    )
      end++;
    text.delete(start, before.length - start - end);
    text.insert(start, after.slice(start, after.length - end));
    return [
      {
        at: start,
        remove: before.length - start - end,
        insert: after.slice(start, after.length - end),
      },
    ];
  }
  const operations: TextOperation[] = [];
  let index = 0,
    original = 0;
  for (const part of parts) {
    const last = operations.at(-1);
    // A removal and an insertion at one place are one replacement.
    const current =
      last && last.at + last.remove === original && (part.added || part.removed)
        ? last
        : part.added || part.removed
          ? operations[operations.push({ at: original, remove: 0, insert: "" }) - 1]
          : null;
    if (part.added) {
      text.insert(index, part.value);
      index += part.value.length;
      if (current) current.insert += part.value;
    } else if (part.removed) {
      text.delete(index, part.value.length);
      original += part.value.length;
      if (current) current.remove += part.value.length;
    } else {
      index += part.value.length;
      original += part.value.length;
    }
  }
  return operations;
}

type Tracked = {
  id: string;
  path: string;
  binary: boolean;
  /** Binary files: server revision and content hash at the last sync. */
  revision: number;
  hash: string | null;
  /** Text files: the live document, and the document as the disk held it at the last sync. */
  doc: Y.Doc | null;
  shadow: Y.Doc | null;
  joined: boolean;
  /** Seen on disk since it was tracked; a tracked file never written locally is not "deleted". */
  present: boolean;
};
type Saved = {
  version: 1;
  project: string;
  files: Array<{
    id: string;
    path: string;
    binary: boolean;
    revision: number;
    hash: string | null;
    present: boolean;
    shadow?: string;
  }>;
};

export type FolderSyncOptions = {
  project: string;
  transport: Transport;
  folder: LocalFolder;
  store: StateStore;
  onStatus?: (status: SyncStatus) => void;
  onNotice?: (notice: SyncNotice) => void;
  /** Quiet period after a change before a document is synced (ms). */
  textDelay?: number;
  /** A tracked file must stay missing this long before it is deleted on the server (ms). */
  deleteDelay?: number;
  /** Full rescan for changes a file watcher missed (ms); 0 disables it. */
  rescanInterval?: number;
  now?: () => Date;
  /**
   * Who to record this folder's edits as, as tracked changes (the project tracks everyone's
   * edits, or this member turned it on), or null when they go in untracked.
   */
  tracking?: () => ChangeAuthor | null;
  /** A text file's shared document changed (its text or its tracked changes). */
  onDocument?: (path: string) => void;
  /** Collaborators' cursors in a text file moved (see `cursors`). */
  onCursors?: (path: string) => void;
};
/** A collaborator's cursor or selection, at places in the file's shared text. */
export type RemoteCursor = {
  id: number;
  name: string;
  color: string;
  anchor: number;
  head: number;
};
/** A tracked change as lists show it, with its text: what was inserted, or what was deleted. */
export type ShownChange = ResolvedChange & { quote: string };

/**
 * Keeps a local folder and a collaboration project in step.
 *
 * Text files: each has a live Y.Doc (server state plus local edits) and a shadow Y.Doc holding
 * what the disk had at the last sync. A local edit is the diff from the shadow's text to the
 * disk, applied to the shadow and merged into the live document as an ordinary Yjs update, so
 * it combines with concurrent remote edits. The merged text is written back only if the file
 * still holds what was read, and the shadow advances only after that write.
 *
 * Binary files and the file list go through the HTTP API. Nothing local is lost: when both
 * sides changed a file, or the server deleted a file with unsynced local edits, the local
 * content is kept as a `.conflict-<time>` copy that stays local.
 */
export class FolderSync {
  private tracked = new Map<string, Tracked>();
  private socket: SocketHandle | null = null;
  private connected = false;
  private queue: Promise<void> = Promise.resolve();
  private busy = 0;
  private dirty = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private rescan: ReturnType<typeof setInterval> | null = null;
  private missingSince = new Map<string, number>();
  private unacked = new Map<string, string>();
  /**
   * Paths whose local state the server does not have, and why: an upload that failed, an edit
   * it refused, a limit, no permission to write. Cleared once the path really syncs.
   */
  private unsynced = new Map<string, string>();
  private told = new Set<string>();
  private sequence = 0;
  private attempts = 0;
  private role: Role | null = null;
  private state: SyncState = "stopped";
  private error: string | null = null;
  private lastSynced: number | null = null;
  private paused = false;
  private stopped = true;
  private missingToConfirm: string[] = [];
  /**
   * Cursors, per text file: collaborators' and this folder's own (one awareness client for
   * every file, so the server counts this computer once), as the web editors share them.
   */
  private cursorDoc = new Y.Doc();
  private awareness = new Map<string, Awareness>();
  private cursorFile: string | null = null;

  constructor(private options: FolderSyncOptions) {}

  private get readOnly() {
    return this.role !== "owner" && this.role !== "editor";
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private api(path = "") {
    return `/api/projects/${this.options.project}${path}`;
  }

  async start() {
    this.stopped = false;
    await this.enqueue(async () => {
      const raw = await this.options.store.load();
      if (raw) this.restore(JSON.parse(raw) as Saved);
    });
    this.connect();
    const every = this.options.rescanInterval ?? 30_000;
    if (every > 0) this.rescan = setInterval(() => this.later("scan", 0), every);
  }

  async stop() {
    this.stopped = true;
    for (const awareness of this.awareness.values()) awareness.destroy();
    this.awareness.clear();
    if (this.rescan) clearInterval(this.rescan);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.socket?.close();
    this.socket = null;
    await this.enqueue(() => this.save());
    this.setState("stopped");
  }

  /** A watcher saw these paths change (or anything, without paths). */
  notifyLocal(paths?: string[]) {
    if (!paths?.length) return this.later("scan", 300);
    for (const path of paths) {
      const t = this.byPath(path);
      if (t && !t.binary) this.markText(t.id, this.options.textDelay ?? 300);
      else this.later("scan", 300);
    }
  }

  /** After a pause because many files disappeared: write them back, or delete them remotely. */
  resolveMissing(choice: "restore" | "delete") {
    const ids = this.missingToConfirm;
    this.missingToConfirm = [];
    this.paused = false;
    void this.enqueue(async () => {
      for (const id of ids) {
        const t = this.tracked.get(id);
        if (!t) continue;
        if (choice === "restore") t.present = false;
        else await this.deleteRemote(t);
      }
      await this.scan();
    });
  }

  /** Resolves once nothing is queued, scheduled or awaiting the server (tests, shutdown). */
  async idle(timeout = 10_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      await this.queue;
      if (!this.busy && !this.timers.size && !this.dirty.size && !this.unacked.size) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("sync did not settle");
  }

  /**
   * Uploads what changed in the folder now and resolves once the server has it: connected,
   * every text file joined, nothing queued, scheduled or unacknowledged. Throws when that
   * cannot happen in time (offline, paused, signed out, still connecting) or a file could not
   * be uploaded (SyncIncomplete names them: refused, too large, read-only), so work that needs
   * the server's copy to match the folder (an AI turn or a build there) does not start on an
   * old one. `idle()` alone would also return while the connection is still being made.
   */
  async flush(timeout = 15_000) {
    const until = Date.now() + timeout;
    this.notifyLocal();
    for (;;) {
      await this.queue;
      const joined = [...this.tracked.values()].every((t) => t.binary || t.joined);
      if (
        this.connected &&
        this.state === "synced" &&
        joined &&
        !this.busy &&
        !this.timers.has("scan") &&
        !this.timers.has("text") &&
        !this.dirty.size &&
        !this.unacked.size
      ) {
        // Settled, but settled is not the same as uploaded.
        if (this.unsynced.size) throw new SyncIncomplete([...this.unsynced.keys()]);
        return;
      }
      if (["paused", "signed-out", "stopped"].includes(this.state))
        throw new Error(`sync ${this.state}`);
      if (Date.now() > until) throw new Error(`sync not settled (${this.state})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** A text file's tracked changes, at their places in its shared text (and that text). */
  trackedChanges(path: string): { text: string; changes: ShownChange[] } | null {
    const t = this.byPath(path);
    if (!t?.doc || t.binary) return null;
    const text = t.doc.getText("content").toString();
    return {
      text,
      changes: resolveChanges(t.doc).changes.map((c) => ({
        ...c,
        quote: c.kind === "insert" ? text.slice(c.from, c.to) : (c.text ?? ""),
      })),
    };
  }

  /**
   * Accepts or rejects tracked changes of a text file (all of them when `ids` is null): the
   * decision goes to the server, and the file is rewritten with the result.
   */
  decide(path: string, ids: string[] | null, accept: boolean) {
    const t = this.byPath(path);
    if (!t?.doc || t.binary || this.readOnly) return false;
    const doc = t.doc;
    const vector = Y.encodeStateVector(doc);
    doc.transact(
      () => decideChanges(doc, ids ?? resolveChanges(doc).changes.map((c) => c.id), accept),
      "local",
    );
    const update = Y.encodeStateAsUpdate(doc, vector);
    if (!hasChanges(update)) return false;
    this.sendUpdate(t, update);
    this.markText(t.id, 0);
    this.options.onDocument?.(t.path);
    return true;
  }

  status(): SyncStatus {
    return {
      state: this.state,
      role: this.role,
      pending: this.unacked.size + this.dirty.size,
      unsynced: [...this.unsynced.keys()],
      lastSynced: this.lastSynced,
      error: this.error,
    };
  }

  // ---- scheduling -------------------------------------------------------------------------

  private enqueue(task: () => Promise<void>) {
    this.busy++;
    const run = this.queue.then(task).catch((error: unknown) => this.failed(error));
    this.queue = run.finally(() => {
      this.busy--;
      this.publish();
    });
    return this.queue;
  }
  private later(key: string, delay: number, task?: () => Promise<void>) {
    if (this.stopped || this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (this.stopped) return;
        void this.enqueue(
          task ??
            (key === "scan"
              ? () => this.scan()
              : key === "refresh"
                ? () => this.refresh()
                : async () => {}),
        );
      }, delay),
    );
    this.publish();
  }
  private markText(id: string, delay: number) {
    this.dirty.add(id);
    this.later("text", delay, async () => {
      const ids = [...this.dirty];
      this.dirty.clear();
      for (const id of ids) {
        const t = this.tracked.get(id);
        if (t) await this.syncText(t);
      }
    });
  }

  // ---- connection -------------------------------------------------------------------------

  private connect() {
    if (this.stopped) return;
    this.setState("connecting");
    this.socket = this.options.transport.connect(this.api("/socket?sync=1"), {
      message: (data) => this.received(data),
      close: () => this.closed(),
    });
  }

  private closed() {
    this.socket = null;
    this.connected = false;
    for (const t of this.tracked.values()) t.joined = false;
    for (const [file, awareness] of this.awareness) {
      const others = [...awareness.getStates().keys()].filter((id) => id !== awareness.clientID);
      if (others.length) {
        removeAwarenessStates(awareness, others, "remote");
        const t = this.tracked.get(file);
        if (t) this.options.onCursors?.(t.path);
      }
    }
    this.unacked.clear();
    if (this.stopped) return;
    this.setState("offline");
    // Learn why before retrying: signed out and removed from the project are final.
    const delay = Math.min(30_000, 1000 * 2 ** this.attempts++);
    this.later("reconnect", delay, async () => {
      try {
        await this.options.transport.request("GET", this.api());
      } catch (error) {
        if (error instanceof RequestError && error.status === 401)
          return this.setState("signed-out", error.message);
        if (error instanceof RequestError && (error.status === 403 || error.status === 404))
          return this.setState("offline", error.message);
        return this.closed();
      }
      this.connect();
    });
  }

  private received(data: string) {
    const msg = JSON.parse(data) as {
      type: string;
      file?: string;
      id?: string;
      update?: string;
      vector?: string;
      role?: Role;
      status?: number;
      message?: string;
    };
    if (msg.type === "ready") {
      this.connected = true;
      this.attempts = 0;
      this.role = msg.role ?? null;
      void this.enqueue(() => this.refresh());
    } else if (msg.type === "joined" && msg.file && msg.update) {
      // Applied at once: the server relays later updates right behind this message.
      this.joined(msg.file, msg.update, msg.vector);
    } else if (msg.type === "update" && msg.file && msg.update) {
      const t = this.tracked.get(msg.file);
      if (t?.doc) {
        Y.applyUpdate(t.doc, fromBase64(msg.update), "remote");
        this.markText(t.id, 50);
        this.options.onDocument?.(t.path);
      }
    } else if (msg.type === "ack" && msg.id) {
      const file = this.unacked.get(msg.id);
      this.unacked.delete(msg.id);
      const acked = file ? this.tracked.get(file) : undefined;
      if (acked) this.cleared(acked.path);
      this.publish();
    } else if (msg.type === "rejected") {
      if (msg.id) this.unacked.delete(msg.id);
      const t = msg.file ? this.tracked.get(msg.file) : undefined;
      if (msg.status === 404) this.later("refresh", 0);
      else if (msg.status === 403) {
        this.role = "viewer";
        if (t) this.blocked(t.path, { kind: "read-only", path: t.path });
      } else if (t)
        this.blocked(t.path, {
          kind: "not-synced",
          path: t.path,
          reason: "server",
          detail: msg.message,
        });
    } else if (msg.type === "awareness" && msg.file && msg.update) {
      const t = this.tracked.get(msg.file);
      if (!t || t.binary) return;
      try {
        applyAwarenessUpdate(this.cursorsOf(t.id), fromBase64(msg.update), "remote");
      } catch {
        return;
      }
      this.options.onCursors?.(t.path);
    } else if (msg.type === "closed" || msg.type === "project-changed") this.later("refresh", 100);
  }

  // ---- cursors ----------------------------------------------------------------------------

  private cursorsOf(file: string) {
    let awareness = this.awareness.get(file);
    if (!awareness) {
      awareness = new Awareness(this.cursorDoc);
      awareness.setLocalState(null);
      // Its own state, renewed every 15 seconds so others keep showing it.
      awareness.on("update", (_: unknown, origin: unknown) => {
        if (origin !== "local" || !awareness) return;
        const t = this.tracked.get(file);
        if (t?.joined && this.socket)
          this.socket.send(
            JSON.stringify({
              type: "awareness",
              file,
              update: toBase64(encodeAwarenessUpdate(awareness, [awareness.clientID])),
            }),
          );
      });
      this.awareness.set(file, awareness);
    }
    return awareness;
  }

  /**
   * Shows this folder's cursor in a text file to collaborators (null hides it); `text` is the
   * editor's text, and positions count only while it matches the shared text. A cursor in
   * another file is hidden first.
   */
  setCursor(path: string | null, cursor: { anchor: number; head: number; text: string } | null) {
    const t = path ? this.byPath(path) : null;
    if (this.cursorFile && this.cursorFile !== t?.id) {
      this.awareness.get(this.cursorFile)?.setLocalState(null);
      this.cursorFile = null;
    }
    if (!t?.doc || t.binary || this.readOnly) return;
    const text = t.doc.getText("content");
    const awareness = this.cursorsOf(t.id);
    if (!cursor || cursor.text !== text.toString()) {
      if (awareness.getLocalState() !== null) awareness.setLocalState(null);
      return;
    }
    const at = (index: number) =>
      Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(text, Math.max(0, Math.min(index, text.length))),
      );
    this.cursorFile = t.id;
    awareness.setLocalState({ cursor: { anchor: at(cursor.anchor), head: at(cursor.head) } });
  }

  /** Collaborators' cursors in a text file, at places in its shared text (and that text). */
  cursors(path: string): { text: string; cursors: RemoteCursor[] } | null {
    const t = this.byPath(path);
    const awareness = t ? this.awareness.get(t.id) : undefined;
    if (!t?.doc || !awareness) return null;
    const doc = t.doc;
    const found: RemoteCursor[] = [];
    for (const [id, state] of awareness.getStates()) {
      if (id === awareness.clientID || !state?.cursor) continue;
      const place = (json: unknown) => {
        try {
          return Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(json),
            doc,
          )?.index;
        } catch {
          return undefined;
        }
      };
      const anchor = place(state.cursor.anchor),
        head = place(state.cursor.head);
      if (anchor === undefined || head === undefined) continue;
      found.push({
        id,
        name: String(state.user?.name ?? ""),
        color: String(state.user?.color ?? "#ea580c"),
        anchor,
        head,
      });
    }
    return { text: doc.getText("content").toString(), cursors: found };
  }

  private join(t: Tracked) {
    if (!this.connected || t.joined || t.binary) return;
    this.socket?.send(
      JSON.stringify({
        type: "join",
        file: t.id,
        ...(t.doc ? { vector: toBase64(Y.encodeStateVector(t.doc)) } : {}),
      }),
    );
  }

  private joined(id: string, update: string, vector?: string) {
    const t = this.tracked.get(id);
    if (!t || t.binary) return;
    t.doc ??= new Y.Doc();
    Y.applyUpdate(t.doc, fromBase64(update), "remote");
    if (!t.shadow) {
      // First sync of this document: the disk is (or will be) the server's text.
      t.shadow = new Y.Doc();
      Y.applyUpdate(t.shadow, Y.encodeStateAsUpdate(t.doc));
    }
    t.joined = true;
    this.options.onDocument?.(t.path);
    // Edits the server never acknowledged (the app quit or the connection dropped).
    if (vector) {
      const missing = Y.encodeStateAsUpdate(t.doc, fromBase64(vector));
      if (hasChanges(missing)) this.sendUpdate(t, missing);
    }
    this.markText(t.id, 0);
  }

  private sendUpdate(t: Tracked, update: Uint8Array) {
    if (this.readOnly || !this.socket) return;
    const id = `${++this.sequence}`;
    this.unacked.set(id, t.id);
    this.socket.send(JSON.stringify({ type: "update", file: t.id, id, update: toBase64(update) }));
  }

  // ---- text documents ---------------------------------------------------------------------

  private async syncText(t: Tracked) {
    if (!t.doc || !t.shadow || !t.joined || this.paused || this.tracked.get(t.id) !== t) return;
    const disk = await this.options.folder.read(t.path);
    if (disk === null) {
      if (t.present) return this.later("scan", 0);
      // Not written locally yet (new on the server, or restored after a pause).
      const text = t.doc.getText("content").toString();
      const advance = Y.encodeStateAsUpdate(t.doc, Y.encodeStateVector(t.shadow));
      if (await this.options.folder.write(t.path, encoder.encode(text), null)) {
        Y.applyUpdate(t.shadow, advance);
        t.present = true;
        this.synced();
      } else this.markText(t.id, 100);
      return;
    }
    t.present = true;
    const diskText = decode(disk);
    if (diskText === null)
      return this.blocked(t.path, { kind: "not-synced", path: t.path, reason: "encoding" });
    const shadowText = t.shadow.getText("content").toString();
    // Nothing of the folder's waits to go up. Not after a refusal: the refused edit is in the
    // shadow already, and only the server acknowledging an edit to this file clears that.
    if (diskText === shadowText && this.unsynced.get(t.path) !== "server") this.cleared(t.path);
    if (diskText !== shadowText) {
      // Local edits are never overwritten, even when they cannot be uploaded.
      if (this.readOnly) return this.blocked(t.path, { kind: "read-only", path: t.path });
      if (disk.length > TEXT_LIMIT)
        return this.blocked(t.path, { kind: "not-synced", path: t.path, reason: "size" });
      const before = Y.encodeStateVector(t.shadow);
      const shadow = t.shadow;
      // Tracking: the edit is recorded in the same update, as the web's editor records typing.
      const who = this.options.tracking?.() ?? null;
      shadow.transact(() => {
        const changes = who ? resolveChanges(shadow).changes : [];
        const operations = applyTextChange(shadow.getText("content"), shadowText, diskText, !!who);
        if (who) trackEdits(shadow, changes, editsFromOperations(shadowText, operations), who);
      });
      const local = Y.encodeStateAsUpdate(shadow, before);
      Y.applyUpdate(t.doc, local, "local");
      this.sendUpdate(t, local);
      this.options.onDocument?.(t.path);
    }
    const text = t.doc.getText("content").toString();
    const advance = Y.encodeStateAsUpdate(t.doc, Y.encodeStateVector(t.shadow));
    if (text !== diskText && !(await this.options.folder.write(t.path, encoder.encode(text), disk)))
      return this.markText(t.id, 100); // Changed while merging: read it again.
    Y.applyUpdate(t.shadow, advance);
    this.synced();
  }

  // ---- file list --------------------------------------------------------------------------

  private async refresh() {
    const remote = await this.options.transport.request<RemoteFile[]>("GET", this.api("/files"));
    const byId = new Map(remote.map((f) => [f.id, f]));
    for (const t of [...this.tracked.values()]) {
      const r = byId.get(t.id);
      if (!r) await this.remoteDeleted(t);
      else if (r.path !== t.path) await this.remoteRenamed(t, r.path);
    }
    for (const r of remote) {
      const t = this.tracked.get(r.id) ?? (await this.remoteAdded(r));
      if (!t) continue;
      if (t.binary && r.revision > t.revision) await this.pullBinary(t);
      else this.join(t);
    }
    await this.scan();
    this.synced();
  }

  private async remoteAdded(r: RemoteFile): Promise<Tracked | null> {
    const t: Tracked = {
      id: r.id,
      path: r.path,
      binary: r.binary,
      revision: 0,
      hash: null,
      doc: null,
      shadow: null,
      joined: false,
      present: false,
    };
    const local = await this.options.folder.read(r.path);
    if (local !== null) {
      // The same path exists locally but was never synced: keep it if it differs.
      const same = r.binary
        ? (await this.download(r.id)).base64 === toBase64(local)
        : decode(local) === (await this.download(r.id)).content;
      if (!same && !(await this.keepCopy(r.path, "conflict-copy"))) return null;
    }
    this.tracked.set(t.id, t);
    if (t.binary) await this.pullBinary(t);
    return t;
  }

  private async remoteRenamed(t: Tracked, path: string) {
    const occupant = this.byPath(path);
    if (occupant && occupant !== t) return; // A swap: settles on a later refresh.
    if (!occupant && (await this.options.folder.read(path)) !== null)
      await this.keepCopy(path, "conflict-copy");
    if ((await this.options.folder.move(t.path, path)) || !t.present) t.path = path;
    else if ((await this.options.folder.read(t.path)) === null) {
      t.path = path;
      t.present = false;
    }
  }

  private async remoteDeleted(t: Tracked) {
    this.untrack(t);
    const disk = await this.options.folder.read(t.path);
    if (disk === null) return;
    const unchanged = t.binary
      ? (await sha256(disk)) === t.hash
      : !!t.shadow && decode(disk) === t.shadow.getText("content").toString();
    if (!(unchanged && (await this.options.folder.remove(t.path, disk))))
      await this.keepCopy(t.path, "deleted-remotely");
  }

  // ---- local folder -----------------------------------------------------------------------

  private async scan() {
    if (this.paused || !this.connected) return;
    const paths = new Set<string>();
    for (const path of await this.options.folder.list()) {
      if (isConflictCopy(path)) continue;
      if (validPath(path)) paths.add(path);
      else this.tell({ kind: "not-synced", path, reason: "path" });
    }
    const added = [...paths].filter((path) => !this.byPath(path));
    const gone: Tracked[] = [];
    for (const t of this.tracked.values()) {
      if (paths.has(t.path)) {
        this.missingSince.delete(t.id);
        t.present = true;
        if (t.binary) await this.pushBinary(t);
        else this.markText(t.id, 0);
      } else if (!t.present) {
        if (t.binary) await this.pullBinary(t);
        else this.markText(t.id, 0);
      } else gone.push(t);
    }
    // A moved folder or a checkout of another branch must not empty the project.
    if (gone.length >= 3 && gone.length > this.tracked.size * 0.2) {
      this.paused = true;
      this.missingToConfirm = gone.map((t) => t.id);
      this.tell({ kind: "paused-missing", count: gone.length }, true);
      return this.setState("paused");
    }
    for (const t of gone) {
      const target = await this.renamedTo(t, added);
      if (target) {
        await this.renameRemote(t, target);
        added.splice(added.indexOf(target), 1);
        continue;
      }
      // Editors that save by deleting and recreating must not delete the shared file.
      const since = this.missingSince.get(t.id) ?? Date.now();
      this.missingSince.set(t.id, since);
      const wait = since + (this.options.deleteDelay ?? 3000) - Date.now();
      if (wait <= 0) await this.deleteRemote(t);
      else this.later("scan", wait + 10);
    }
    for (const path of added) await this.uploadNew(path);
  }

  private async renamedTo(t: Tracked, added: string[]) {
    for (const path of added) {
      if (isTextPath(path) === t.binary) continue;
      const bytes = await this.options.folder.read(path);
      if (!bytes) continue;
      const same = t.binary
        ? (await sha256(bytes)) === t.hash
        : !!t.shadow && decode(bytes) === t.shadow.getText("content").toString();
      if (same) return path;
    }
    return null;
  }

  private async renameRemote(t: Tracked, path: string) {
    if (this.readOnly) return this.blocked(path, { kind: "read-only", path });
    try {
      await this.options.transport.request("PATCH", this.api(`/files/${t.id}`), { path });
      this.cleared(t.path);
      this.cleared(path);
      t.path = path;
      this.missingSince.delete(t.id);
    } catch (error) {
      this.serverProblem(path, error);
    }
  }

  private async deleteRemote(t: Tracked) {
    this.missingSince.delete(t.id);
    if (this.readOnly) return this.blocked(t.path, { kind: "read-only", path: t.path });
    try {
      await this.options.transport.request("DELETE", this.api(`/files/${t.id}`));
    } catch (error) {
      if (!(error instanceof RequestError && error.status === 404))
        return this.serverProblem(t.path, error);
    }
    this.untrack(t);
  }

  private async uploadNew(path: string) {
    const bytes = await this.options.folder.read(path);
    if (!bytes) return this.cleared(path);
    if (this.readOnly) return this.blocked(path, { kind: "read-only", path });
    const binary = !isTextPath(path);
    if (bytes.length > (binary ? BINARY_LIMIT : TEXT_LIMIT))
      return this.blocked(path, { kind: "not-synced", path, reason: "size" });
    const text = binary ? null : decode(bytes);
    if (!binary && text === null)
      return this.blocked(path, { kind: "not-synced", path, reason: "encoding" });
    try {
      const info = await this.options.transport.request<RemoteFile>(
        "POST",
        this.api("/files"),
        binary ? { path, base64: toBase64(bytes) } : { path, content: text },
      );
      const t: Tracked = {
        id: info.id,
        path,
        binary,
        revision: info.revision,
        hash: binary ? await sha256(bytes) : null,
        doc: null,
        shadow: null,
        joined: false,
        present: true,
      };
      this.tracked.set(t.id, t);
      this.cleared(path);
      this.join(t);
    } catch (error) {
      // Someone created the same path meanwhile: the next refresh keeps both versions.
      if (error instanceof RequestError && error.status === 409) this.later("refresh", 0);
      else this.serverProblem(path, error);
    }
  }

  // ---- binary files -----------------------------------------------------------------------

  private download(id: string) {
    return this.options.transport.request<{ revision: number; base64?: string; content?: string }>(
      "GET",
      this.api(`/files/${id}`),
    );
  }

  private async pullBinary(t: Tracked) {
    const remote = await this.download(t.id);
    const bytes = fromBase64(remote.base64 ?? "");
    let disk = await this.options.folder.read(t.path);
    if (disk !== null && t.hash !== null && (await sha256(disk)) !== t.hash) {
      if (!(await this.keepCopy(t.path, "conflict-copy"))) return;
      disk = null;
    }
    if (disk !== null && toBase64(disk) === remote.base64) {
      t.revision = remote.revision;
      t.hash = await sha256(bytes);
      t.present = true;
      return;
    }
    if (await this.options.folder.write(t.path, bytes, disk)) {
      t.revision = remote.revision;
      t.hash = await sha256(bytes);
      t.present = true;
      this.synced();
    } else this.later("refresh", 200);
  }

  private async pushBinary(t: Tracked) {
    const disk = await this.options.folder.read(t.path);
    if (!disk) return;
    const hash = await sha256(disk);
    if (hash === t.hash) return this.cleared(t.path);
    if (t.hash === null) {
      t.hash = hash; // Adopted at an identical path before any change.
      return;
    }
    if (this.readOnly) return this.blocked(t.path, { kind: "read-only", path: t.path });
    if (disk.length > BINARY_LIMIT)
      return this.blocked(t.path, { kind: "not-synced", path: t.path, reason: "size" });
    try {
      const saved = await this.options.transport.request<{ revision: number }>(
        "PUT",
        this.api(`/files/${t.id}`),
        { base64: toBase64(disk), revision: t.revision },
      );
      t.revision = saved.revision;
      t.hash = hash;
      this.cleared(t.path);
      this.synced();
    } catch (error) {
      // Replaced remotely first: pulling it keeps this version as a conflict copy.
      if (error instanceof RequestError && error.status === 409) this.later("refresh", 0);
      else this.serverProblem(t.path, error);
    }
  }

  // ---- helpers ----------------------------------------------------------------------------

  private byPath(path: string) {
    for (const t of this.tracked.values()) if (t.path === path) return t;
    return undefined;
  }

  private untrack(t: Tracked) {
    this.cleared(t.path);
    this.tracked.delete(t.id);
    this.dirty.delete(t.id);
    this.missingSince.delete(t.id);
    if (t.joined) this.socket?.send(JSON.stringify({ type: "leave", file: t.id }));
    t.doc?.destroy();
    t.shadow?.destroy();
  }

  /** Moves a local file aside so a server version can take its place; it stays local. */
  private async keepCopy(path: string, kind: "conflict-copy" | "deleted-remotely") {
    const copy = conflictCopyPath(path, this.now());
    const moved = await this.options.folder.move(path, copy);
    if (moved) this.tell({ kind, path, copy }, true);
    return moved;
  }

  private serverProblem(path: string, error: unknown) {
    if (error instanceof RequestError && error.status === 401)
      this.setState("signed-out", error.message);
    else
      this.blocked(path, {
        kind: "not-synced",
        path,
        reason: "server",
        detail: error instanceof Error ? error.message : String(error),
      });
  }

  /** The folder's version of `path` did not reach the server; flush() fails until it does. */
  private blocked(path: string, notice: SyncNotice) {
    this.unsynced.set(path, notice.kind === "not-synced" ? notice.reason : notice.kind);
    this.tell(notice);
    this.publish();
  }

  private cleared(path: string) {
    if (this.unsynced.delete(path)) this.publish();
  }

  private tell(notice: SyncNotice, always = false) {
    const key = JSON.stringify(notice);
    if (!always && this.told.has(key)) return;
    this.told.add(key);
    this.options.onNotice?.(notice);
  }

  private failed(error: unknown) {
    if (error instanceof RequestError && error.status === 401)
      return this.setState("signed-out", error.message);
    this.error = error instanceof Error ? error.message : String(error);
    this.publish();
  }

  private synced() {
    this.lastSynced = Date.now();
    this.later("save", 500, () => this.save());
  }

  private setState(state: SyncState, error: string | null = null) {
    this.state = state;
    this.error = error;
    this.publish();
  }

  private publish() {
    if (this.connected && !this.paused && !["signed-out", "stopped"].includes(this.state))
      this.state =
        this.busy ||
        this.dirty.size ||
        this.unacked.size ||
        this.timers.has("text") ||
        this.timers.has("scan")
          ? "syncing"
          : "synced";
    this.options.onStatus?.(this.status());
  }

  private restore(saved: Saved) {
    if (saved.version !== 1 || saved.project !== this.options.project) return;
    for (const f of saved.files) {
      let shadow: Y.Doc | null = null,
        doc: Y.Doc | null = null;
      if (f.shadow) {
        shadow = new Y.Doc();
        Y.applyUpdate(shadow, fromBase64(f.shadow));
        doc = new Y.Doc();
        Y.applyUpdate(doc, fromBase64(f.shadow));
      }
      this.tracked.set(f.id, { ...f, doc, shadow, joined: false });
    }
  }

  private async save() {
    const saved: Saved = {
      version: 1,
      project: this.options.project,
      files: [...this.tracked.values()].map((t) => ({
        id: t.id,
        path: t.path,
        binary: t.binary,
        revision: t.revision,
        hash: t.hash,
        present: t.present,
        ...(t.shadow ? { shadow: toBase64(Y.encodeStateAsUpdate(t.shadow)) } : {}),
      })),
    };
    await this.options.store.save(JSON.stringify(saved));
  }
}
