import { i18n } from "@/lib/i18n";
export type TranscriptStorage = {
  put: (key: string, value: unknown) => Promise<void>;
  get: <T>(key: string) => Promise<T | undefined>;
  remove: (key: string) => Promise<void>;
};
/** State machine serializes spill/wake and never discards a snapshot until it can be recovered. */
export class IdleTranscript<T> {
  private saved = false;
  private operation: Promise<void> | null = null;
  private disposed = false;
  constructor(
    private key: string,
    private storage: TranscriptStorage,
    private current: () => { value: T; canSleep: boolean },
    private release: () => void,
    private restore: (snapshot: T) => void,
    private changed: (sleeping: boolean) => void,
  ) {}
  async sleep() {
    if (this.disposed || this.saved || this.operation || !this.current().canSleep) return;
    const snapshot = this.current().value;
    const run = async () => {
      await this.storage.put(this.key, snapshot);
      if (!this.disposed && this.current().canSleep && this.current().value === snapshot) {
        this.saved = true;
        this.release();
        this.changed(true);
      } else await this.storage.remove(this.key);
    };
    this.operation = run();
    try {
      await this.operation;
    } finally {
      this.operation = null;
    }
  }
  async wake() {
    if (this.operation) await this.operation;
    if (this.disposed || !this.saved) return;
    const run = async () => {
      const snapshot = await this.storage.get<T>(this.key);
      if (this.disposed) return;
      if (snapshot === undefined)
        throw new Error(i18n.t("msg.theCachedHistoryIsGoneReopenThisConversa"));
      this.restore(snapshot);
      this.saved = false;
      this.changed(false);
      await this.storage.remove(this.key);
    };
    if (this.operation) {
      await this.operation;
      return;
    }
    this.operation = run();
    try {
      await this.operation;
    } finally {
      this.operation = null;
    }
  }
  dispose() {
    this.disposed = true;
    void (this.operation ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.storage.remove(this.key))
      .catch(() => {});
  }
}
export function mergeById<T extends { id: string }>(saved: T[], live: T[]): T[] {
  const current = new Map(live.map((item) => [item.id, item]));
  const result = saved.map((item) => current.get(item.id) ?? item);
  const ids = new Set(saved.map((item) => item.id));
  return [...result, ...live.filter((item) => !ids.has(item.id))];
}
