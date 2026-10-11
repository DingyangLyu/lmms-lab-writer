"use client";
/**
 * The desktop's side of the workbench spell checker (the web's is apps/collaboration/src/spell/
 * client.ts): one worker for every editor with Hunspell's en_US, the answers remembered, and
 * the member's own words kept on this computer.
 */
import { setSpellService } from "@lmms-lab/workbench";

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
  // By path: the package exports only its Node entry, which reads these with fs.
  loaded ??= call({
    init: {
      aff: new URL("../../../node_modules/dictionary-en/index.aff", import.meta.url).href,
      dic: new URL("../../../node_modules/dictionary-en/index.dic", import.meta.url).href,
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
const notify = () => {
  for (const listener of listeners) listener();
};
const keep = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify([...own].sort()));
  } catch {
    /* Kept until the app closes. */
  }
};
/** The dictionary's verdict on each word asked so far: true when misspelled. */
const verdicts = new Map<string, boolean>();

setSpellService({
  async misspelled(words) {
    await load();
    const unknown = [...new Set(words)].filter((w) => !verdicts.has(w) && !known(w));
    if (unknown.length) {
      const reply = await call({ check: unknown });
      const wrong = new Set(reply.misspelled ?? []);
      for (const w of unknown) verdicts.set(w, wrong.has(w));
    }
    return new Set(words.filter((w) => verdicts.get(w) && !known(w)));
  },
  async suggestions(word) {
    await load();
    return (await call({ suggest: word })).suggestions ?? [];
  },
  addWord(word) {
    own.add(word);
    keep();
    notify();
  },
  ignoreWord(word) {
    ignored.add(word);
    notify();
  },
  onWordsChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});
