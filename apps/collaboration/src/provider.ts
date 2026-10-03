import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { base64, unbase64 } from "./api";
export type SyncStatus = "connecting" | "saved" | "saving" | "offline" | "denied";
export type Person = { id: string; name: string };
export class WriterProvider {
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);
  cache: IndexeddbPersistence;
  socket: WebSocket | null = null;
  stopped = false;
  retry: ReturnType<typeof setTimeout> | null = null;
  pending = new Set<string>();
  ready = false;
  editable = false;
  unsynced = false;
  beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.unsynced) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  constructor(
    public project: string,
    public file: string,
    public user: Person,
    private status: (status: SyncStatus) => void,
    private role: (role: string) => void,
    private error: (text: string) => void,
  ) {
    this.cache = new IndexeddbPersistence(
      `writer:${location.origin}:${user.id}:${project}:${file}`,
      this.doc,
    );
    const hue = [...user.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
    this.awareness.setLocalStateField("user", {
      name: user.name,
      color: `hsl(${hue},65%,42%)`,
      colorLight: `hsl(${hue},65%,85%)`,
    });
    this.doc.on("update", this.onUpdate);
    window.addEventListener("beforeunload", this.beforeUnload);
    this.awareness.on("update", this.onAwareness);
    void this.cache.whenSynced
      .then(() => this.connect())
      .catch((e) => {
        this.error(`本机离线草稿保存不可用：${String(e)}`);
        this.connect();
      });
  }
  onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || origin === this.cache) return;
    this.unsynced = true;
    if (this.ready && this.editable) this.sendUpdate(update);
    else this.status("offline");
  };
  sendUpdate(update: Uint8Array) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const id = crypto.randomUUID();
    this.unsynced = true;
    this.pending.add(id);
    this.status("saving");
    this.socket.send(JSON.stringify({ type: "update", id, update: base64(update) }));
  }
  onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(
        JSON.stringify({
          type: "awareness",
          update: base64(encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed])),
        }),
      );
  };
  connect() {
    if (this.stopped) return;
    this.status("connecting");
    this.ready = false;
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/projects/${this.project}/socket?file=${this.file}`,
    );
    this.socket = socket;
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "ready") {
          const serverDoc = new Y.Doc();
          Y.applyUpdate(serverDoc, unbase64(msg.state));
          const vector = Y.encodeStateVector(serverDoc);
          serverDoc.destroy();
          Y.applyUpdate(this.doc, unbase64(msg.state), this);
          this.editable = ["owner", "editor"].includes(msg.role);
          this.role(msg.role);
          this.ready = true;
          this.pending.clear();
          const local = Y.encodeStateAsUpdate(this.doc, vector);
          if (local.length > 2 && this.editable) this.sendUpdate(local);
          else if (local.length > 2) {
            this.status("denied");
            this.error("权限已改变，本机未同步文字仍保留，可导出恢复副本；不会覆盖服务器。");
          } else {
            this.unsynced = false;
            this.status("saved");
          }
          this.onAwareness({ added: [this.doc.clientID], updated: [], removed: [] }, null);
        } else if (msg.type === "update") Y.applyUpdate(this.doc, unbase64(msg.update), this);
        else if (msg.type === "awareness")
          applyAwarenessUpdate(this.awareness, unbase64(msg.update), this);
        else if (msg.type === "ack") {
          this.pending.delete(msg.id);
          if (!this.pending.size) {
            this.unsynced = false;
            this.status("saved");
          }
        } else if (msg.type === "error") {
          this.error(msg.message);
          this.status("denied");
          this.editable = false;
          this.role("viewer");
        }
      } catch (e) {
        this.error(`同步数据错误：${String(e)}`);
      }
    };
    socket.onclose = (event) => {
      this.ready = false;
      if (this.stopped) return;
      if (event.code === 1008) {
        this.status("denied");
        this.editable = false;
        this.role("viewer");
        this.error(event.reason || "连接权限失效，请重新登录；本机草稿保留。");
        return;
      }
      this.status("offline");
      this.retry = setTimeout(() => this.connect(), 1500);
    };
    socket.onerror = () => {
      if (!this.stopped) this.status("offline");
    };
  }
  destroy() {
    this.stopped = true;
    window.removeEventListener("beforeunload", this.beforeUnload);
    if (this.retry) clearTimeout(this.retry);
    this.awareness.setLocalState(null);
    this.socket?.close();
    this.doc.off("update", this.onUpdate);
    this.awareness.off("update", this.onAwareness);
    this.awareness.destroy();
    void this.cache.destroy();
    this.doc.destroy();
  }
}
