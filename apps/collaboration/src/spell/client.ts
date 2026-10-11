/**
 * The page's side of the spell checker: one worker for every editor, the answers remembered,
 * the member's own words (kept with their account, and in this browser to start at once) and
 * those ignored for this visit.
 */

import { setSpellService } from "@lmms-lab/workbench";
// By path: the package exports only its Node entry, which reads these with fs.
import affUrl from "../../node_modules/dictionary-en/index.aff?url";
import dicUrl from "../../node_modules/dictionary-en/index.dic?url";
import { api } from "../api";

type Reply = { id: number; error?: string; misspelled?: string[]; suggestions?: string[] };

let worker: Worker | null = null,
  next = 0,
  loaded: Promise<unknown> | null = null;
const waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();

function call(message: Record<string, unknown>) {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      const pending = waiting.get(reply.id);
      waiting.delete(reply.id);
      if (reply.error) pending?.reject(new Error(reply.error));
      else pending?.resolve(reply);
    };
  }
  const id = ++next;
  return new Promise<Reply>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker?.postMessage({ id, ...message });
  });
}
function load() {
  loaded ??= call({
    init: {
      aff: affUrl.startsWith("data:") ? affUrl : new URL(affUrl, location.href).href,
      dic: dicUrl.startsWith("data:") ? dicUrl : new URL(dicUrl, location.href).href,
    },
  }).catch((error) => {
    loaded = null;
    throw error;
  });
  return loaded;
}

const KEY = "writer-spell-words";
const own = new Set<string>(
  (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(saved) ? saved.filter((w) => typeof w === "string") : [];
    } catch {
      return [];
    }
  })(),
);
const ignored = new Set<string>();
const listeners = new Set<() => void>();
const known = (word: string) => own.has(word) || own.has(word.toLowerCase()) || ignored.has(word);

/** Called when the member adds or ignores a word, so every editor checks again. */
export function onWordsChanged(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const notify = () => {
  for (const listener of listeners) listener();
};
const keep = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify([...own].sort()));
  } catch {
    /* Kept for this visit. */
  }
};
/** Set once this browser's earlier words have gone to an account. */
const MOVED = "writer-spell-words-moved";
let synced: Promise<void> | null = null;
/**
 * Takes the account's words (once per page). Words this browser kept before dictionaries
 * lived with accounts go to the account the first time.
 */
export function syncWords() {
  synced ??= (async () => {
    try {
      const words = await api<string[]>("/me/words");
      let moved = true;
      try {
        moved = localStorage.getItem(MOVED) === "1";
      } catch {}
      const earlier = moved ? [] : [...own].filter((w) => !words.includes(w));
      if (earlier.length) await api("/me/words", { words: earlier });
      try {
        localStorage.setItem(MOVED, "1");
      } catch {}
      own.clear();
      for (const w of [...words, ...earlier]) own.add(w);
      keep();
      notify();
    } catch {
      synced = null; // Signed out, or offline: the browser's copy serves until next time.
    }
  })();
  return synced;
}
/** The member's own words, sorted. */
export const ownWords = () => [...own].sort((a, b) => a.localeCompare(b));
export function addWord(word: string) {
  own.add(word);
  keep();
  notify();
  void api("/me/words", { word }).catch(() => {});
}
export function removeWord(word: string) {
  own.delete(word);
  keep();
  notify();
  void api("/me/words/remove", { word }).catch(() => {});
}
export function ignoreWord(word: string) {
  ignored.add(word);
  notify();
}

/** The dictionary's verdict on each word asked so far: true when misspelled. */
const verdicts = new Map<string, boolean>();
/** Which of `words` are misspelled, asking the dictionary only about new ones. */
export async function misspelled(words: string[]) {
  void syncWords();
  await load();
  const unknown = [...new Set(words)].filter((w) => !verdicts.has(w) && !known(w));
  if (unknown.length) {
    const reply = await call({ check: unknown });
    const wrong = new Set(reply.misspelled ?? []);
    for (const w of unknown) verdicts.set(w, wrong.has(w));
  }
  return new Set(words.filter((w) => verdicts.get(w) && !known(w)));
}
export async function suggestions(word: string) {
  await load();
  return (await call({ suggest: word })).suggestions ?? [];
}
setSpellService({ misspelled, suggestions, addWord, ignoreWord, onWordsChanged });
