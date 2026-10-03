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
import { fail, type Store, type User } from "./store";

type Peer = {
  socket: WebSocket;
  user: User;
  project: string;
  file: string | null;
  clients: Set<number>;
  authenticate: () => void;
};
type Room = { doc: Y.Doc; awareness: Awareness; peers: Set<Peer> };
/** Keystroke updates are durable individually; the audit trail records activity, not keystrokes. */
const EDIT_AUDIT_INTERVAL = 60_000;
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
export class Collaboration {
  wss = new WebSocketServer({ noServer: true, maxPayload: 3_000_000 });
  rooms = new Map<string, Room>();
  peers = new Set<Peer>();
  private edits = new Map<string, { at: number; updates: number; bytes: number }>();
  private sweep: ReturnType<typeof setInterval>;
  constructor(
    public store: Store,
    private origin: () => string,
  ) {
    this.sweep = setInterval(() => {
      for (const peer of this.peers)
        try {
          peer.authenticate();
        } catch {
          peer.socket.close(1008, "登录或项目权限已失效");
        }
    }, 30000);
    this.sweep.unref();
  }
  room(project: string, file: string) {
    const key = `${project}:${file}`;
    let room = this.rooms.get(key);
    if (room) return room;
    const row = this.store.file(project, file);
    if (row.binary) fail(400, "二进制文件不支持共同编辑");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row.state);
    const awareness = new Awareness(doc);
    awareness.setLocalState(null);
    room = { doc, awareness, peers: new Set() };
    this.rooms.set(key, room);
    return room;
  }
  /** Rooms only live while someone is connected; the database stays authoritative. */
  private release(project: string, file: string) {
    const key = `${project}:${file}`,
      room = this.rooms.get(key);
    if (!room || room.peers.size) return;
    room.awareness.destroy();
    room.doc.destroy();
    this.rooms.delete(key);
  }
  private auditEdit(project: string, file: string, user: string, bytes: number) {
    const key = `${project}:${file}:${user}`,
      now = Date.now(),
      entry = this.edits.get(key) ?? { at: 0, updates: 0, bytes: 0 };
    entry.updates++;
    entry.bytes += bytes;
    if (now - entry.at >= EDIT_AUDIT_INTERVAL) {
      this.store.audit(project, user, "document.edit", {
        file,
        updates: entry.updates,
        bytes: entry.bytes,
      });
      entry.at = now;
      entry.updates = 0;
      entry.bytes = 0;
    }
    this.edits.set(key, entry);
    if (this.edits.size > 10_000)
      for (const [k, e] of this.edits) if (now - e.at >= EDIT_AUDIT_INTERVAL) this.edits.delete(k);
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      if (!allowedOrigin(req.headers.origin, this.origin())) fail(403, "Origin 不匹配");
      const url = new URL(req.url ?? "", this.origin());
      const match = /^\/api\/projects\/([^/]+)\/socket$/.exec(url.pathname);
      if (!match?.[1]) fail(404, "连接不存在");
      const project = match[1],
        user = userFor(this.store, req),
        role = this.store.require(project, user.id);
      const file = url.searchParams.get("file");
      if (
        this.peers.size >= 128 ||
        [...this.peers].filter((p) => p.user.id === user.id).length >= 16
      )
        fail(429, "同时连接数量达到上限");
      if (file && this.store.file(project, file).binary) fail(400, "二进制文件不支持共同编辑");
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const peer: Peer = {
          socket: ws,
          user,
          project,
          file,
          clients: new Set(),
          authenticate: () => {
            const live = userFor(this.store, req);
            this.store.require(project, live.id);
          },
        };
        let room: Room | null;
        try {
          room = file ? this.room(project, file) : null;
        } catch (e) {
          ws.close(1008, e instanceof Error ? e.message : "文档不可用");
          return;
        }
        this.peers.add(peer);
        if (room) room.peers.add(peer);
        ws.send(
          JSON.stringify({
            type: "ready",
            role,
            user: { id: user.id, name: user.username },
            state: room ? Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64") : null,
          }),
        );
        if (room?.awareness.getStates().size)
          ws.send(
            JSON.stringify({
              type: "awareness",
              update: Buffer.from(
                encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
              ).toString("base64"),
            }),
          );
        ws.on("message", (raw) => {
          try {
            const current = userFor(this.store, req);
            this.store.require(project, current.id);
            if (file && !this.store.fileExists(project, file)) fail(404, "文档不存在");
            const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (msg.type === "update" && room && file) {
              this.store.require(project, current.id, "edit");
              if (
                typeof msg.id !== "string" ||
                msg.id.length > 80 ||
                typeof msg.update !== "string" ||
                msg.update.length > 2_800_000 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(msg.update)
              )
                fail(400, "无效更新");
              const update = Buffer.from(msg.update, "base64");
              const candidate = new Y.Doc();
              try {
                Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
                Y.applyUpdate(candidate, update);
                if (
                  Buffer.byteLength(candidate.getText("content").toString()) > 2_000_000 ||
                  [...candidate.share.keys()].some((k) => k !== "content")
                )
                  fail(413, "文档超过限制");
                const state = Y.encodeStateAsUpdate(candidate);
                if (state.length > 8_000_000) fail(413, "文档历史过大，请创建新文档快照");
                this.store.run(
                  "UPDATE files SET state=?,revision=revision+1 WHERE id=? AND project=?",
                  state,
                  file,
                  project,
                );
                this.auditEdit(project, file, current.id, update.length);
                Y.applyUpdate(room.doc, update, peer);
                for (const other of room.peers)
                  if (other !== peer && other.socket.readyState === WebSocket.OPEN)
                    other.socket.send(JSON.stringify({ type: "update", update: msg.update }));
                ws.send(JSON.stringify({ type: "ack", id: msg.id }));
              } finally {
                candidate.destroy();
              }
            } else if (msg.type === "awareness" && room) {
              if (typeof msg.update !== "string" || msg.update.length > 16_000)
                fail(400, "无效光标信息");
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
              for (const other of room.peers)
                if (other !== peer && other.socket.readyState === WebSocket.OPEN)
                  other.socket.send(
                    JSON.stringify({
                      type: "awareness",
                      update: Buffer.from(safe).toString("base64"),
                    }),
                  );
            } else if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
            else fail(400, "未知消息");
          } catch (e) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: e instanceof Error ? e.message : "同步失败",
              }),
            );
            ws.close(1008);
          }
        });
        ws.on("close", () => {
          this.peers.delete(peer);
          if (!room || !file) return;
          room.peers.delete(peer);
          // Only announce cursors the room actually knows; an unknown ID has no clock.
          const known = [...peer.clients].filter((id) => room.awareness.meta.has(id));
          removeAwarenessStates(room.awareness, known, peer);
          if (known.length && room.peers.size) {
            const update = Buffer.from(encodeAwarenessUpdate(room.awareness, known)).toString(
              "base64",
            );
            for (const other of room.peers)
              if (other.socket.readyState === WebSocket.OPEN)
                other.socket.send(JSON.stringify({ type: "awareness", update }));
          }
          this.release(project, file);
        });
        ws.on("error", () => {});
      });
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  }
  changed(project: string) {
    for (const peer of this.peers)
      if (peer.project === project && peer.socket.readyState === WebSocket.OPEN)
        peer.socket.send(JSON.stringify({ type: "project-changed" }));
  }
  revoke(project: string, user: string) {
    for (const p of this.peers)
      if (p.project === project && p.user.id === user) p.socket.close(1008, "项目权限已变更");
  }
  /** Prepare all documents, commit their states together, then broadcast. */
  replaceMany(
    project: string,
    plans: { file: string; expected: string; content: string }[],
    actor: string,
    effects?: () => void,
  ) {
    const prepared: {
      file: string;
      room: Room;
      clone: Y.Doc;
      update: Uint8Array;
      state: Uint8Array;
    }[] = [];
    const opened = new Set<string>();
    try {
      for (const plan of plans) {
        opened.add(plan.file);
        const room = this.room(project, plan.file);
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
        Y.applyUpdate(clone, Y.encodeStateAsUpdate(room.doc));
        const value = clone.getText("content");
        clone.transact(() => {
          for (const edit of edits.reverse()) {
            value.delete(edit.at, edit.remove);
            value.insert(edit.at, edit.insert);
          }
        });
        const state = Y.encodeStateAsUpdate(clone);
        if (state.length > 8_000_000) {
          clone.destroy();
          fail(413, "文档历史过大");
        }
        const update = Y.encodeStateAsUpdate(clone, Y.encodeStateVector(room.doc));
        prepared.push({ file: plan.file, room, clone, state, update });
      }
      this.store.transaction(() => {
        for (const p of prepared) {
          this.store.run(
            "UPDATE files SET state=?,revision=revision+1 WHERE id=? AND project=?",
            p.state,
            p.file,
            project,
          );
          this.store.audit(project, actor, "document.replace", { file: p.file });
        }
        effects?.();
      });
      for (const p of prepared) {
        Y.applyUpdate(p.room.doc, p.update);
        for (const peer of p.room.peers)
          if (peer.socket.readyState === WebSocket.OPEN)
            peer.socket.send(
              JSON.stringify({ type: "update", update: Buffer.from(p.update).toString("base64") }),
            );
      }
      this.changed(project);
    } finally {
      for (const p of prepared) p.clone.destroy();
      // Includes rooms opened for a plan that failed before it was prepared.
      for (const file of opened) this.release(project, file);
    }
  }
  replace(project: string, file: string, expected: string, content: string, actor: string) {
    this.replaceMany(project, [{ file, expected, content }], actor);
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
