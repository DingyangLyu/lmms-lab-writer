import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Locale } from "@lmms-lab/i18n";
import { diffChars } from "diff";
import * as decoding from "lib0/decoding";
import { WebSocket, WebSocketServer } from "ws";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  modifyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { allowedOrigin, bearer, userFor } from "./auth";
import { type Sql, sql } from "./db";
import { requestLocale, say } from "./messages";
import type { Store, User } from "./store";
import { fail, HttpError } from "./util";

type Peer = {
  socket: WebSocket;
  user: User;
  project: string;
  /** The one document of a web editor socket; null for project and sync sockets. */
  file: string | null;
  /** A desktop folder sync: one socket joins any number of the project's documents. */
  sync: boolean;
  rooms: Map<string, Room>;
  clients: Set<number>;
  /** Wording of errors and close reasons for this client (`?locale=en`). */
  locale: Locale;
  authenticate: () => Promise<void>;
};
/** The project file limit, so one sync socket can follow every document. */
const MAX_SYNC_ROOMS = 2000;
type Room = {
  key: string;
  project: string;
  file: string;
  doc: Y.Doc;
  awareness: Awareness;
  peers: Set<Peer>;
  /** Updates appended since the last compaction. */
  pending: number;
  pendingBytes: number;
};
/** Keystroke updates are durable individually; the audit trail records activity, not keystrokes. */
const EDIT_AUDIT_INTERVAL = 60_000;
/** Fold appended updates into the stored state once a document has this much history. */
const COMPACT_UPDATES = 200,
  COMPACT_BYTES = 512_000;
/** Stable per-account cursor colour; clients cannot choose another person's identity. */
export function cursorColors(user: string) {
  const hue = [...user].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
  return { color: `hsl(${hue},65%,42%)`, colorLight: `hsl(${hue},65%,85%)` };
}
function awarenessClients(bytes: Uint8Array) {
  const decoder = decoding.createDecoder(bytes);
  const count = decoding.readVarUint(decoder);
  if (count > 2) fail(400, "光标数量超限");
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    JSON.parse(decoding.readVarString(decoder));
  }
  return ids;
}
const send = (socket: WebSocket, message: unknown) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};
const roomKey = (project: string, file: string) => `${project}:${file}`;
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
/** Close reasons are limited to 123 bytes. */
const closeWith = (peer: Pick<Peer, "socket" | "locale">, code: number, reason: string) => {
  let text = say(peer.locale, reason);
  while (Buffer.byteLength(text) > 123) text = text.slice(0, -1);
  peer.socket.close(code, text);
};
const wording = (locale: Locale, error: unknown, fallback: string) =>
  error instanceof HttpError ? say(locale, error.template, error.params) : say(locale, fallback);
const logFailure = (what: string) => (error: unknown) =>
  console.error(`Writer ${what} failed:`, error instanceof Error ? error.message : error);

/**
 * One in-memory Y.Doc per open document. Every change is appended to the database before
 * it is applied, acknowledged or broadcast, so the database is always the complete record.
 * All changes to one document run under its lock; database transactions never wait for a lock.
 */
export class Collaboration {
  wss = new WebSocketServer({ noServer: true, maxPayload: 3_000_000 });
  rooms = new Map<string, Room>();
  peers = new Set<Peer>();
  private locks = new Map<string, Promise<void>>();
  private edits = new Map<string, { at: number; updates: number; bytes: number }>();
  private sweep: ReturnType<typeof setInterval>;
  constructor(
    public store: Store,
    private origin: () => string,
  ) {
    this.sweep = setInterval(() => {
      for (const peer of this.peers)
        void peer.authenticate().catch(() => closeWith(peer, 1008, "登录或项目权限已失效"));
    }, 30000);
    this.sweep.unref();
  }
  private async lock(key: string) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    };
  }
  /** Locks are taken in sorted order, so multi-document edits cannot deadlock. */
  private async exclusive<T>(keys: string[], action: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    try {
      for (const key of [...new Set(keys)].sort()) releases.push(await this.lock(key));
      return await action();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
  /** Caller holds the document lock. */
  private async open(project: string, file: string) {
    const key = roomKey(project, file);
    const existing = this.rooms.get(key);
    if (existing) return existing;
    const row = await this.store.file(project, file);
    if (row.binary) fail(400, "二进制文件不支持共同编辑");
    const pending = await this.store.pending(file);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row.state);
    const awareness = new Awareness(doc);
    awareness.setLocalState(null);
    const room: Room = {
      key,
      project,
      file,
      doc,
      awareness,
      peers: new Set(),
      pending: pending.count,
      pendingBytes: pending.bytes,
    };
    this.rooms.set(key, room);
    return room;
  }
  /** Caller holds the document lock. Failure keeps the appended rows, which stay readable. */
  private async compact(room: Room) {
    if (!room.pending) return;
    await this.store.compact(room.file);
    room.pending = 0;
    room.pendingBytes = 0;
  }
  /** Rooms only live while someone is connected; the database stays authoritative. */
  private async release(project: string, file: string) {
    const key = roomKey(project, file);
    await this.exclusive([key], async () => {
      const room = this.rooms.get(key);
      if (!room || room.peers.size) return;
      this.rooms.delete(key);
      room.awareness.destroy();
      room.doc.destroy();
      await this.compact(room).catch(logFailure("compaction"));
    });
  }
  /** Web editors know their document; sync sockets are told which one changed. */
  private relay(room: Room, from: Peer | null, update: string) {
    for (const other of room.peers)
      if (other !== from)
        send(
          other.socket,
          other.sync ? { type: "update", file: room.file, update } : { type: "update", update },
        );
  }
  private leave(peer: Peer, room: Room) {
    if (!room.peers.delete(peer)) return;
    peer.rooms.delete(room.file);
    // Only announce cursors the room actually knows; an unknown ID has no clock.
    const known = [...peer.clients].filter((id) => room.awareness.meta.has(id));
    removeAwarenessStates(room.awareness, known, peer);
    if (known.length && room.peers.size) {
      const update = base64(encodeAwarenessUpdate(room.awareness, known));
      for (const other of room.peers)
        if (!other.sync) send(other.socket, { type: "awareness", update });
    }
    if (!room.peers.size)
      void this.release(room.project, room.file).catch(logFailure("room release"));
  }
  private async auditEdit(project: string, file: string, user: string, bytes: number) {
    const key = `${project}:${file}:${user}`,
      now = Date.now(),
      entry = this.edits.get(key) ?? { at: 0, updates: 0, bytes: 0 };
    entry.updates++;
    entry.bytes += bytes;
    this.edits.set(key, entry);
    if (this.edits.size > 10_000)
      for (const [k, e] of this.edits) if (now - e.at >= EDIT_AUDIT_INTERVAL) this.edits.delete(k);
    if (now - entry.at < EDIT_AUDIT_INTERVAL) return;
    const detail = { file, updates: entry.updates, bytes: entry.bytes };
    entry.at = now;
    entry.updates = 0;
    entry.bytes = 0;
    await this.store.audit(project, user, "document.edit", detail);
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    void this.accept(req, socket, head).catch(() => {
      if (socket.writable) socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
  }
  private async accept(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!bearer(req) && !allowedOrigin(req.headers.origin, this.origin()))
      fail(403, "Origin 不匹配");
    const url = new URL(req.url ?? "", this.origin());
    const match = /^\/api\/projects\/([^/]+)\/socket$/.exec(url.pathname);
    if (!match?.[1]) fail(404, "连接不存在");
    const project = match[1],
      user = await userFor(this.store, req);
    if (user.mustChange) fail(403, "请先修改临时密码");
    const role = await this.store.require(project, user.id);
    const file = url.searchParams.get("file"),
      sync = url.searchParams.get("sync") === "1",
      locale: Locale = url.searchParams.get("locale") === "en" ? "en" : requestLocale(req.headers);
    if (sync && file) fail(400, "同步连接不指定文件");
    if (this.peers.size >= 128 || [...this.peers].filter((p) => p.user.id === user.id).length >= 16)
      fail(429, "同时连接数量达到上限");
    if (file && (await this.store.fileMeta(project, file)).binary)
      fail(400, "二进制文件不支持共同编辑");
    const ws = await new Promise<WebSocket>((resolve) =>
      this.wss.handleUpgrade(req, socket, head, resolve),
    );
    const peer: Peer = {
      socket: ws,
      user,
      project,
      file,
      sync,
      rooms: new Map(),
      clients: new Set(),
      locale,
      authenticate: async () => {
        const live = await userFor(this.store, req);
        await this.store.require(project, live.id);
      },
    };
    let closed = false;
    const detach = () => {
      this.peers.delete(peer);
      for (const room of [...peer.rooms.values()]) this.leave(peer, room);
    };
    // Listen before the room opens: an early close or message must not be lost.
    let opened: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    ws.on("message", (raw) => {
      void ready
        .then(() => this.message(peer, req, raw.toString()))
        .catch((e) => {
          send(ws, { type: "error", message: wording(locale, e, "同步失败") });
          ws.close(1008);
        });
    });
    ws.on("close", () => {
      closed = true;
      detach();
    });
    ws.on("error", () => {});
    try {
      if (file)
        await this.exclusive([roomKey(project, file)], async () => {
          const r = await this.open(project, file);
          r.peers.add(peer);
          peer.rooms.set(file, r);
          // Encoded under the lock, so no acknowledged update can be missing from it.
          send(ws, {
            type: "ready",
            role,
            user: { id: user.id, name: user.username },
            state: Buffer.from(Y.encodeStateAsUpdate(r.doc)).toString("base64"),
          });
          if (r.awareness.getStates().size)
            send(ws, {
              type: "awareness",
              update: Buffer.from(
                encodeAwarenessUpdate(r.awareness, [...r.awareness.getStates().keys()]),
              ).toString("base64"),
            });
        });
      else
        send(ws, {
          type: "ready",
          role,
          user: { id: user.id, name: user.username },
          state: null,
          sync,
        });
    } catch (e) {
      closeWith(peer, 1008, e instanceof HttpError ? e.template : "文档不可用");
      return;
    }
    this.peers.add(peer);
    opened();
    if (closed) detach();
  }
  private async message(peer: Peer, req: IncomingMessage, raw: string) {
    const { project, file } = peer;
    const current = await userFor(this.store, req);
    await this.store.require(project, current.id);
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (msg.type === "ping") return send(peer.socket, { type: "pong" });
    if (peer.sync) return this.syncMessage(peer, current, msg);
    const room = file ? (peer.rooms.get(file) ?? null) : null;
    if (file && !(await this.store.fileExists(project, file))) fail(404, "文档不存在");
    if (msg.type === "update" && room) {
      await this.applyUpdate(peer, room, current, msg);
      send(peer.socket, { type: "ack", id: msg.id });
    } else if (msg.type === "awareness" && room) {
      if (typeof msg.update !== "string" || msg.update.length > 16_000) fail(400, "无效光标信息");
      const bytes = Buffer.from(msg.update, "base64");
      // Validate the whole message before recording any client ID; a rejected
      // message must leave no half-registered cursor behind.
      const ids = awarenessClients(bytes);
      for (const id of ids)
        if ([...room.peers].some((other) => other !== peer && other.clients.has(id)))
          fail(403, "不能修改其他人的光标");
      if (new Set([...peer.clients, ...ids]).size > 2) fail(400, "光标数量超限");
      for (const id of ids) peer.clients.add(id);
      const user = { name: current.username, ...cursorColors(current.id) };
      const safe = modifyAwarenessUpdate(bytes, (state: Record<string, unknown> | null) =>
        state === null ? null : { ...state, user },
      );
      applyAwarenessUpdate(room.awareness, safe, peer);
      const update = base64(safe);
      for (const other of room.peers)
        if (other !== peer && !other.sync) send(other.socket, { type: "awareness", update });
    } else fail(400, "未知消息");
  }
  /**
   * Desktop sync: `join` (optionally with the state vector it already has) answers with the
   * missing part of the document; updates and acks name their document. A problem with one
   * document is reported for that document and leaves the socket open.
   */
  private async syncMessage(peer: Peer, current: User, msg: Record<string, unknown>) {
    const file = typeof msg.file === "string" && msg.file.length <= 80 ? msg.file : null;
    if (!file) fail(400, "无效文档");
    const { project } = peer;
    try {
      if (msg.type === "join") {
        if (peer.rooms.size >= MAX_SYNC_ROOMS && !peer.rooms.has(file))
          fail(429, "同步的文档数量达到上限");
        if ((await this.store.fileMeta(project, file)).binary)
          fail(400, "二进制文件不支持共同编辑");
        let vector: Uint8Array | undefined;
        if (typeof msg.vector === "string")
          try {
            vector = Buffer.from(msg.vector, "base64");
            Y.decodeStateVector(vector);
          } catch {
            fail(400, "无效状态向量");
          }
        await this.exclusive([roomKey(project, file)], async () => {
          const room = await this.open(project, file);
          room.peers.add(peer);
          peer.rooms.set(file, room);
          send(peer.socket, {
            type: "joined",
            file,
            update: base64(Y.encodeStateAsUpdate(room.doc, vector)),
            // Lets the client send back whatever the server is missing.
            vector: base64(Y.encodeStateVector(room.doc)),
          });
        });
      } else if (msg.type === "leave") {
        const room = peer.rooms.get(file);
        if (room) this.leave(peer, room);
      } else if (msg.type === "update") {
        const room = peer.rooms.get(file) ?? fail(409, "请先加入文档");
        if (!(await this.store.fileExists(project, file))) fail(404, "文档不存在");
        await this.applyUpdate(peer, room, current, msg);
        send(peer.socket, { type: "ack", file, id: msg.id });
      } else fail(400, "未知消息");
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      send(peer.socket, {
        type: "rejected",
        file,
        id: typeof msg.id === "string" ? msg.id : undefined,
        status: error.status,
        message: wording(peer.locale, error, "同步失败"),
      });
    }
  }
  /** Validates, stores, applies and relays one update; the caller acknowledges it. */
  private async applyUpdate(peer: Peer, room: Room, current: User, msg: Record<string, unknown>) {
    await this.store.require(peer.project, current.id, "edit");
    if (
      typeof msg.id !== "string" ||
      msg.id.length > 80 ||
      typeof msg.update !== "string" ||
      msg.update.length > 2_800_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(msg.update)
    )
      fail(400, "无效更新");
    const update = Buffer.from(msg.update, "base64"),
      encoded = msg.update;
    await this.exclusive([room.key], async () => {
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
        Y.applyUpdate(candidate, update);
        if (
          Buffer.byteLength(candidate.getText("content").toString()) > 2_000_000 ||
          [...candidate.share.keys()].some((k) => k !== "content")
        )
          fail(413, "文档超过限制");
        if (Y.encodeStateAsUpdate(candidate).length > 8_000_000)
          fail(413, "文档历史过大，请创建新文档快照");
      } finally {
        candidate.destroy();
      }
      await this.store.appendUpdate(room.file, update);
      room.pending++;
      room.pendingBytes += update.length;
      Y.applyUpdate(room.doc, update, peer);
      this.relay(room, peer, encoded);
      if (room.pending >= COMPACT_UPDATES || room.pendingBytes >= COMPACT_BYTES)
        await this.compact(room).catch(logFailure("compaction"));
    });
    await this.auditEdit(peer.project, room.file, current.id, update.length);
  }
  changed(project: string) {
    for (const peer of this.peers)
      if (peer.project === project) send(peer.socket, { type: "project-changed" });
  }
  revoke(project: string, user: string) {
    for (const p of this.peers)
      if (p.project === project && p.user.id === user) closeWith(p, 1008, "项目权限已变更");
  }
  /** Close code 4001 asks clients to reconnect, picking up a changed role. */
  refreshMember(project: string, user: string) {
    for (const p of this.peers)
      if (p.project === project && p.user.id === user) closeWith(p, 4001, "权限已更新");
  }
  /** Close all editors of a project and wait until their rooms are released. */
  async closeProject(project: string, reason: string) {
    for (const p of this.peers) if (p.project === project) closeWith(p, 1008, reason);
    for (const room of [...this.rooms.values()].filter((r) => r.project === project)) {
      for (const peer of room.peers) peer.socket.terminate();
      room.peers.clear();
      await this.release(project, room.file);
    }
  }
  /** Close every connection of an account (logout, password change, removal). */
  disconnectUser(user: string, reason: string) {
    for (const p of this.peers) if (p.user.id === user) closeWith(p, 1008, reason);
  }
  closeFile(file: string, reason: string) {
    for (const p of this.peers) {
      const room = p.rooms.get(file);
      if (p.file === file) closeWith(p, 1008, reason);
      else if (p.sync && room) {
        send(p.socket, { type: "closed", file, reason: say(p.locale, reason) });
        this.leave(p, room);
      }
    }
  }
  /** Current text of a document, including edits not yet compacted. */
  async text(project: string, file: string) {
    return this.exclusive([roomKey(project, file)], async () => {
      const room = this.rooms.get(roomKey(project, file));
      if (room) return room.doc.getText("content").toString();
      const row = await this.store.file(project, file);
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, row.state);
        return doc.getText("content").toString();
      } finally {
        doc.destroy();
      }
    });
  }
  /**
   * Replace whole documents as one collaborative edit. Every plan is checked against the
   * live text; the updates and `effects` commit in one transaction, then rooms apply them.
   */
  async replaceMany(
    project: string,
    plans: { file: string; expected: string; content: string }[],
    actor: string,
    effects?: (tx: Sql) => Promise<void>,
  ) {
    const opened = new Set<string>();
    try {
      await this.exclusive(
        plans.map((p) => roomKey(project, p.file)),
        async () => {
          const prepared: { room: Room; update: Uint8Array }[] = [];
          for (const plan of plans) {
            opened.add(plan.file);
            const room = await this.open(project, plan.file);
            if (room.doc.getText("content").toString() !== plan.expected)
              fail(409, "文档已有新的修改，请刷新审阅");
            if (Buffer.byteLength(plan.content) > 2_000_000) fail(413, "文档超过 2 MB");
            const diff = diffChars(plan.expected, plan.content, { timeout: 500 });
            if (!diff) fail(413, "修改过大，请拆分后审阅");
            const edits: { at: number; remove: number; insert: string }[] = [];
            let offset = 0;
            for (const part of diff) {
              if (part.added || part.removed) {
                let edit = edits.at(-1);
                if (!edit || edit.at + edit.remove !== offset) {
                  edit = { at: offset, remove: 0, insert: "" };
                  edits.push(edit);
                }
                if (part.added) edit.insert += part.value;
                else {
                  edit.remove += part.value.length;
                  offset += part.value.length;
                }
              } else offset += part.value.length;
            }
            const clone = new Y.Doc();
            try {
              Y.applyUpdate(clone, Y.encodeStateAsUpdate(room.doc));
              const value = clone.getText("content");
              clone.transact(() => {
                for (const edit of edits.reverse()) {
                  value.delete(edit.at, edit.remove);
                  value.insert(edit.at, edit.insert);
                }
              });
              if (Y.encodeStateAsUpdate(clone).length > 8_000_000) fail(413, "文档历史过大");
              prepared.push({
                room,
                update: Y.encodeStateAsUpdate(clone, Y.encodeStateVector(room.doc)),
              });
            } finally {
              clone.destroy();
            }
          }
          await this.store.db.transaction(async (tx) => {
            for (const p of prepared) {
              await this.store.appendUpdate(p.room.file, p.update, tx);
              await tx.run(sql`UPDATE files SET revision=revision+1 WHERE id=${p.room.file}`);
              await this.store.audit(project, actor, "document.replace", { file: p.room.file }, tx);
            }
            await effects?.(tx);
          });
          for (const p of prepared) {
            Y.applyUpdate(p.room.doc, p.update);
            p.room.pending++;
            p.room.pendingBytes += p.update.length;
            this.relay(p.room, null, base64(p.update));
          }
        },
      );
    } finally {
      // Includes rooms opened for a plan that failed before it was prepared.
      for (const file of opened) await this.release(project, file);
    }
    this.changed(project);
  }
  replace(project: string, file: string, expected: string, content: string, actor: string) {
    return this.replaceMany(project, [{ file, expected, content }], actor);
  }
  close() {
    clearInterval(this.sweep);
    for (const p of this.peers) p.socket.terminate();
    for (const r of this.rooms.values()) {
      r.awareness.destroy();
      r.doc.destroy();
    }
    this.rooms.clear();
    this.wss.close();
  }
}
