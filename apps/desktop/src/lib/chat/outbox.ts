import type { EditorSelectionContext } from "@/lib/editor/selection-context";
import { i18n } from "@/lib/i18n";
import type { ChatImageFile } from "./images";
export type ChatDraft = {
  raw: string;
  files: ChatImageFile[];
  selection: EditorSelectionContext | null;
};
export type QueuedMessage = ChatDraft & {
  id: string;
  createdAt: number;
  state: "queued" | "sending" | "uncertain";
};
export type OutboxSnapshot = {
  items: QueuedMessage[];
  paused: boolean;
  error: string | null;
  loaded: boolean;
};
export interface OutboxStorage {
  load(key: string): Promise<OutboxSnapshot | null>;
  save(key: string, value: OutboxSnapshot): Promise<void>;
}

/** One accepted message per completion boundary, independent of React render timing. */
export class ChatOutbox {
  state: OutboxSnapshot = { items: [], paused: false, error: null, loaded: false };
  private listeners = new Set<() => void>();
  private serial: Promise<unknown> = Promise.resolve();
  private dispatching = false;
  private waitingEpoch: number | null = null;
  /** The connection dropped after a delivery, so its completion may never be observed. */
  private lostWhileWaiting = false;
  private loading: Promise<void> | null = null;
  private pauseRequested = false;
  private pauseVersion = 0;
  private environment = { ready: false, busy: false, completion: 0 };
  constructor(
    readonly key: string,
    private storage: OutboxStorage,
    private deliver: (message: QueuedMessage) => Promise<void>,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify() {
    for (const listener of this.listeners) listener();
  }
  load() {
    this.loading ??= this.loadInitial();
    return this.loading;
  }
  private async loadInitial() {
    try {
      const saved = await this.storage.load(this.key);
      if (saved?.items.length)
        this.state = {
          ...saved,
          loaded: true,
          paused: true,
          items: saved.items.map((item) => ({
            ...item,
            state: item.state === "sending" ? "uncertain" : item.state,
          })),
          error: saved.items.some((i) => i.state === "sending")
            ? i18n.t("msg.theLastSendWasNotConfirmedCheckTheHistor")
            : i18n.t("msg.theLocalQueueWasRestoredClickContinueToS"),
        };
      else this.state = { ...this.state, loaded: true };
    } catch (cause) {
      this.state = {
        ...this.state,
        paused: true,
        loaded: false,
        error: i18n.t("msg.couldNotReadTheQueueError", { error: String(cause) }),
      };
    }
    this.notify();
  }
  private change(edit: (current: OutboxSnapshot) => OutboxSnapshot): Promise<void> {
    const task = this.serial
      .catch(() => {})
      .then(async () => {
        try {
          const next = edit(this.state);
          await this.storage.save(this.key, next);
          this.state = next;
          this.notify();
        } catch (cause) {
          this.state = {
            ...this.state,
            error: i18n.t("msg.couldNotSaveTheQueueError", { error: String(cause) }),
          };
          this.notify();
          throw cause;
        }
      });
    this.serial = task;
    return task;
  }
  update(environment: typeof this.environment) {
    if (this.waitingEpoch !== null && this.environment.ready && !environment.ready)
      this.lostWhileWaiting = true;
    this.environment = environment;
    void this.pump();
  }
  async enqueue(draft: ChatDraft) {
    if (!this.state.loaded) throw new Error(i18n.t("msg.theQueueIsNotReadyYetYourInputWasKept"));
    const message: QueuedMessage = {
      ...structuredClone(draft),
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      state: "queued",
    };
    await this.change((current) => {
      if (current.items.length >= 50)
        throw new Error(i18n.t("msg.eachConversationCanHoldAtMost50QueuedMes"));
      return { ...current, items: [...current.items, message] };
    });
    void this.pump();
  }
  async remove(id: string) {
    await this.change((current) => ({
      ...current,
      items: current.items.filter((item) => item.id !== id || item.state === "sending"),
    }));
  }
  async move(id: string, direction: -1 | 1) {
    await this.change((current) => {
      const items = [...current.items];
      const from = items.findIndex((item) => item.id === id),
        to = from + direction;
      if (
        from >= 0 &&
        to >= 0 &&
        to < items.length &&
        items[from]?.state !== "sending" &&
        items[to]?.state !== "sending"
      )
        [items[from], items[to]] = [items[to] as QueuedMessage, items[from] as QueuedMessage];
      return { ...current, items };
    });
  }
  async pause(reason?: string) {
    this.pauseVersion++;
    this.pauseRequested = true;
    this.state = { ...this.state, paused: true, error: reason || this.state.error };
    this.notify();
    await this.change((current) => ({ ...current, paused: true }));
  }
  async resume() {
    const version = ++this.pauseVersion;
    this.waitingEpoch = null;
    this.lostWhileWaiting = false;
    await this.change((current) => ({
      ...current,
      paused: false,
      error: null,
      items: current.items.map((item) =>
        item.state === "uncertain" ? { ...item, state: "queued" } : item,
      ),
    }));
    if (version === this.pauseVersion) this.pauseRequested = false;
    void this.pump();
  }
  private async pump() {
    const { ready, busy, completion } = this.environment;
    if (this.waitingEpoch !== null && completion > this.waitingEpoch) {
      this.waitingEpoch = null;
      this.lostWhileWaiting = false;
    }
    if (this.lostWhileWaiting && ready && !busy && this.waitingEpoch !== null) {
      // Reconnected idle without a completion: never release the next message blindly.
      this.lostWhileWaiting = false;
      this.waitingEpoch = null;
      if (this.state.items.length && !this.state.paused)
        void this.pause(i18n.t("msg.theConnectionDroppedBeforeTheLastMessage")).catch(() => {});
      return;
    }
    if (
      !ready ||
      busy ||
      !this.state.loaded ||
      this.state.paused ||
      this.pauseRequested ||
      this.dispatching ||
      this.waitingEpoch !== null ||
      !this.state.items.length
    )
      return;
    const first = this.state.items[0];
    if (first?.state !== "queued") return;
    this.dispatching = true;
    try {
      await this.change((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.id === first.id ? { ...item, state: "sending" } : item,
        ),
      }));
      // A stop, connection loss, or session switch may occur while persisting the claim.
      if (!this.state.items.some((item) => item.id === first.id && item.state === "sending"))
        return;
      if (
        this.pauseRequested ||
        this.state.paused ||
        !this.environment.ready ||
        this.environment.busy
      ) {
        await this.change((current) => ({
          ...current,
          items: current.items.map((item) =>
            item.id === first.id ? { ...item, state: "queued" } : item,
          ),
        }));
        return;
      }
      this.waitingEpoch = this.environment.completion;
      await this.deliver(first);
      await this.change((current) => ({
        ...current,
        items: current.items.filter((item) => item.id !== first.id),
      }));
    } catch (cause) {
      this.state = {
        ...this.state,
        paused: true,
        error: i18n.t("msg.sendingFromTheQueueFailedTheRemainingMes", { error: String(cause) }),
        items: this.state.items.map((item) =>
          item.id === first.id ? { ...item, state: "uncertain" } : item,
        ),
      };
      this.notify();
      try {
        await this.change((current) => current);
      } catch {
        /* The durable sending claim remains paused on recovery. */
      }
    } finally {
      this.dispatching = false;
      void this.pump();
    }
  }
}

let database: Promise<IDBDatabase> | undefined;
function db() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("writer-chat-outbox", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("queues");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  });
  return database;
}
export const outboxStorage: OutboxStorage = {
  async load(key) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const request = database.transaction("queues").objectStore("queues").get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  },
  async save(key, value) {
    const database = await db();
    return new Promise<void>((resolve, reject) => {
      const tx = database.transaction("queues", "readwrite");
      tx.objectStore("queues").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Queue transaction aborted"));
    });
  },
};
