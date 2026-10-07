import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
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
import { allowedOrigin, userFor } from "./auth";
import { type Sql, sql } from "./db";
import type { Store, User } from "./store";
import { fail } from "./util";

type Peer = {
  socket: WebSocket;
  user: User;
  project: string;
  file: string | null;
  clients: Set<number>;
  authenticate: () => Promise<void>;
};
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
        void peer.authenticate().catch(() => peer.socket.close(1008, "登录或项目权限已失效"));
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
    if (!allowedOrigin(req.headers.origin, this.origin())) fail(403, "Origin 不匹配");
    const url = new URL(req.url ?? "", this.origin());
    const match = /^\/api\/projects\/([^/]+)\/socket$/.exec(url.pathname);
    if (!match?.[1]) fail(404, "连接不存在");
    const project = match[1],
      user = await userFor(this.store, req);
    if (user.mustChange) fail(403, "请先修改临时密码");
    const role = await this.store.require(project, user.id);
    const file = url.searchParams.get("file");
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
      clients: new Set(),
      authenticate: async () => {
        const live = await userFor(this.store, req);
        await this.store.require(project, live.id);
      },
    };
    let room: Room | null = null,
      closed = false;
    const detach = () => {
      this.peers.delete(peer);
      const r = room;
      if (!r || !file || !r.peers.delete(peer)) return;
      // Only announce cursors the room actually knows; an unknown ID has no clock.
      const known = [...peer.clients].filter((id) => r.awareness.meta.has(id));
      removeAwarenessStates(r.awareness, known, peer);
      if (known.length && r.peers.size) {
        const update = Buffer.from(encodeAwarenessUpdate(r.awareness, known)).toString("base64");
        for (const other of r.peers) send(other.socket, { type: "awareness", update });
      }
      if (!r.peers.size) void this.release(project, file).catch(logFailure("room release"));
    };
    // Listen before the room opens: an early close or message must not be lost.
    let opened: (room: Room | null) => void = () => {};
    const ready = new Promise<Room | null>((resolve) => {
      opened = resolve;
    });
    ws.on("message", (raw) => {
      void ready
        .then((r) => this.message(peer, r, req, raw.toString()))
        .catch((e) => {
          send(ws, { type: "error", message: e instanceof Error ? e.message : "同步失败" });
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
        room = await this.exclusive([roomKey(project, file)], async () => {
          const r = await this.open(project, file);
          r.peers.add(peer);
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
          return r;
        });
      else
        send(ws, { type: "ready", role, user: { id: user.id, name: user.username }, state: null });
    } catch (e) {
      ws.close(1008, e instanceof Error ? e.message : "文档不可用");
      return;
    }
    this.peers.add(peer);
    opened(room);
    if (closed) detach();
  }
  private async message(peer: Peer, room: Room | null, req: IncomingMessage, raw: string) {
    const { project, file } = peer;
    const current = await userFor(this.store, req);
    await this.store.require(project, current.id);
    if (file && !(await this.store.fileExists(project, file))) fail(404, "文档不存在");
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (msg.type === "update" && room && file) {
      await this.store.require(project, current.id, "edit");
      if (
        typeof msg.id !== "string" ||
        msg.id.length > 80 ||
        typeof msg.update !== "string" ||
        msg.update.length > 2_800_000 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(msg.update)
      )
        fail(400, "无效更新");
      const update = Buffer.from(msg.update, "base64"),
        id = msg.id,
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
        await this.store.appendUpdate(file, update);
        room.pending++;
        room.pendingBytes += update.length;
        Y.applyUpdate(room.doc, update, peer);
        for (const other of room.peers)
          if (other !== peer) send(other.socket, { type: "update", update: encoded });
        send(peer.socket, { type: "ack", id });
        if (room.pending >= COMPACT_UPDATES || room.pendingBytes >= COMPACT_BYTES)
          await this.compact(room).catch(logFailure("compaction"));
      });
      await this.auditEdit(project, file, current.id, update.length);
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
      const update = Buffer.from(safe).toString("base64");
      for (const other of room.peers)
        if (other !== peer) send(other.socket, { type: "awareness", update });
    } else if (msg.type === "ping") send(peer.socket, { type: "pong" });
    else fail(400, "未知消息");
  }
  changed(project: string) {
    for (const peer of this.peers)
      if (peer.project === project) send(peer.socket, { type: "project-changed" });
  }
  revoke(project: string, user: string) {
    for (const p of this.peers)
      if (p.project === project && p.user.id === user) p.socket.close(1008, "项目权限已变更");
  }
  /** Close code 4001 asks clients to reconnect, picking up a changed role. */
  refreshMember(project: string, user: string) {
    for (const p of this.peers)
      if (p.project === project && p.user.id === user) p.socket.close(4001, "权限已更新");
  }
  /** Close all editors of a project and wait until their rooms are released. */
  async closeProject(project: string, reason: string) {
    for (const p of this.peers) if (p.project === project) p.socket.close(1008, reason);
    for (const room of [...this.rooms.values()].filter((r) => r.project === project)) {
      for (const peer of room.peers) peer.socket.terminate();
      room.peers.clear();
      await this.release(project, room.file);
    }
  }
  /** Close every connection of an account (logout, password change, removal). */
  disconnectUser(user: string, reason: string) {
    for (const p of this.peers) if (p.user.id === user) p.socket.close(1008, reason);
  }
  closeFile(file: string, reason: string) {
    for (const p of this.peers) if (p.file === file) p.socket.close(1008, reason);
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
            const update = Buffer.from(p.update).toString("base64");
            for (const peer of p.room.peers) send(peer.socket, { type: "update", update });
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
