/**
 * The spell checker's dictionary (Hunspell's en_US, through nspell), loaded once in a worker so
 * neither loading it nor checking a page of words holds up typing. Each app starts it from a
 * one-line entry of its own (`import "@lmms-lab/workbench/spell-worker"`) and passes the
 * dictionary files' URLs, which its bundler provides.
 */
import NSpell from "nspell";
import { type Dictionary, derived } from "./derived";

type Request =
  | { id: number; init: { aff: string; dic: string } }
  | { id: number; check: string[] }
  | { id: number; suggest: string };

let checker: Promise<ReturnType<typeof NSpell>> | null = null;

/** The dictionary's word, or one built from its words ("composable", "subgraphs"). */
function correct(spell: ReturnType<typeof NSpell>, word: string) {
  if (spell.correct(word)) return true;
  // nspell keeps each root's affix flags here; the rules ask whether a root has a plural.
  const roots = (spell as unknown as { data?: Record<string, string[] | undefined> }).data ?? {};
  const dict: Dictionary = { correct: (w) => spell.correct(w), flags: (w) => roots[w] };
  return derived(word, dict);
}
/**
 * A dictionary file: fetched, or decoded when the build inlined it as a data URL (the page's
 * policy allows fetching only from the server itself).
 */
async function read(url: string) {
  const inline = /^data:[^,]*?(;base64)?,([\s\S]*)$/.exec(url);
  if (inline) {
    const data = inline[2] ?? "";
    if (!inline[1]) return decodeURIComponent(data);
    return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.text();
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const message = event.data;
  try {
    if ("init" in message) {
      checker ??= Promise.all([read(message.init.aff), read(message.init.dic)]).then(([aff, dic]) =>
        NSpell(aff, dic),
      );
      await checker;
      postMessage({ id: message.id, ok: true });
      return;
    }
    if (!checker) throw new Error("not loaded");
    const spell = await checker;
    if ("check" in message)
      postMessage({ id: message.id, misspelled: message.check.filter((w) => !correct(spell, w)) });
    else postMessage({ id: message.id, suggestions: spell.suggest(message.suggest).slice(0, 6) });
  } catch (error) {
    postMessage({ id: message.id, error: String(error) });
  }
};
