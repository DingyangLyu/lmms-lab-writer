"use client";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import type { ChatImageFile } from "./images";

/** Unsent composer text and attachments, per project conversation tab. Images stay in IndexedDB. */
type Draft = { text: string; files: ChatImageFile[] };
const SAVE_DELAY_MS = 300;
let database: Promise<IDBDatabase> | undefined;
function db() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("writer-composer-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  });
  return database;
}
const draftKey = (project: string, tabId: string) => JSON.stringify([project, tabId]);
async function readDraft(key: string): Promise<Draft | null> {
  const store = (await db()).transaction("drafts").objectStore("drafts");
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as Draft | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}
async function writeDraft(key: string, draft: Draft | null) {
  const tx = (await db()).transaction("drafts", "readwrite");
  if (draft) tx.objectStore("drafts").put(draft, key);
  else tx.objectStore("drafts").delete(key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
/** Drop drafts of tabs that no longer exist in a project's restored workspace. */
export async function pruneComposerDrafts(project: string, tabIds: ReadonlySet<string>) {
  const tx = (await db()).transaction("drafts", "readwrite");
  const store = tx.objectStore("drafts");
  const request = store.getAllKeys();
  request.onsuccess = () => {
    for (const key of request.result) {
      try {
        const [owner, tab] = JSON.parse(String(key)) as [string, string];
        if (owner === project && !tabIds.has(tab)) store.delete(key);
      } catch {
        store.delete(key);
      }
    }
  };
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function useComposerDraft(
  project: string | undefined,
  tabId: string | undefined,
  text: string,
  setText: Dispatch<SetStateAction<string>>,
  files: ChatImageFile[],
  setFiles: Dispatch<SetStateAction<ChatImageFile[]>>,
) {
  const key = project && tabId ? draftKey(project, tabId) : null;
  const latest = useRef({ text, files });
  latest.current = { text, files };
  const loaded = useRef<string | null>(null);
  const pending = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const save = (target: string) => {
    const { text, files } = latest.current;
    void writeDraft(target, text.trim() || files.length ? { text, files } : null).catch(() => {
      /* Drafts are a convenience copy; the composer keeps its live content. */
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: setters are stable; save reads refs.
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    loaded.current = null;
    void readDraft(key)
      .then((draft) => {
        if (cancelled) return;
        // Never overwrite what the user already typed while the draft was loading.
        if (draft && !latest.current.text && !latest.current.files.length) {
          setText(draft.text);
          setFiles(draft.files);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) loaded.current = key;
      });
    return () => {
      cancelled = true;
      if (pending.current?.key === key) {
        clearTimeout(pending.current.timer);
        pending.current = null;
        if (loaded.current === key) save(key);
      }
    };
  }, [key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: text/files changes schedule a save.
  useEffect(() => {
    if (!key || loaded.current !== key) return;
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = {
      key,
      timer: setTimeout(() => {
        pending.current = null;
        save(key);
      }, SAVE_DELAY_MS),
    };
  }, [key, text, files]);
}
