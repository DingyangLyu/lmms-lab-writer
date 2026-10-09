/** Disposable UI snapshots, separate from native agent histories and queued messages. */
let database: Promise<IDBDatabase> | undefined;
function open() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("writer-transcript-cache", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      // Controllers live in memory, so snapshots from a previous page load are unreachable.
      // The flag survives module hot reloads (whose controllers stay mounted), not page loads.
      const page = globalThis as { writerTranscriptCacheCleared?: boolean };
      if (page.writerTranscriptCacheCleared) return resolve(db);
      page.writerTranscriptCacheCleared = true;
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").clear();
      tx.oncomplete = () => resolve(db);
      tx.onerror = () => resolve(db);
      tx.onabort = () => resolve(db);
    };
  });
  return database;
}
export const transcriptCache = {
  async put(key: string, value: unknown) {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  async get<T>(key: string) {
    const db = await open();
    return new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction("snapshots").objectStore("snapshots").get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  },
  async remove(key: string) {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};
