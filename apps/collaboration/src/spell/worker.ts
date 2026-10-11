/**
 * The spell checker's dictionary (Hunspell's en_US, through nspell), loaded once in a worker so
 * neither loading it nor checking a page of words holds up typing.
 */
import NSpell from "nspell";

type Request =
  | { id: number; init: { aff: string; dic: string } }
  | { id: number; check: string[] }
  | { id: number; suggest: string };

let checker: Promise<ReturnType<typeof NSpell>> | null = null;
/**
 * A dictionary file: fetched, or decoded when the build inlined it as a data URL (the page's
 * policy allows fetching only from the server itself).
 */
async function read(url: string) {
  const inline = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
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
      postMessage({ id: message.id, misspelled: message.check.filter((w) => !spell.correct(w)) });
    else postMessage({ id: message.id, suggestions: spell.suggest(message.suggest).slice(0, 6) });
  } catch (error) {
    postMessage({ id: message.id, error: String(error) });
  }
};
