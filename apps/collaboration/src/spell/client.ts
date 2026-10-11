/**
 * The page's side of the spell checker: one worker for every editor, the answers remembered,
 * and the member's own words (kept in this browser) and those ignored for this visit.
 */
// By path: the package exports only its Node entry, which reads these with fs.
import affUrl from "../../node_modules/dictionary-en/index.aff?url";
import dicUrl from "../../node_modules/dictionary-en/index.dic?url";

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
export function addWord(word: string) {
  own.add(word);
  try {
    localStorage.setItem(KEY, JSON.stringify([...own].sort()));
  } catch {
    /* Kept for this visit. */
  }
  for (const listener of listeners) listener();
}
export function ignoreWord(word: string) {
  ignored.add(word);
  for (const listener of listeners) listener();
}

/** The dictionary's verdict on each word asked so far: true when misspelled. */
const verdicts = new Map<string, boolean>();
/** Which of `words` are misspelled, asking the dictionary only about new ones. */
export async function misspelled(words: string[]) {
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
