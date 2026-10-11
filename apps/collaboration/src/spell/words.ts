/**
 * The words of a LaTeX text worth checking: prose only (see nonProse), without acronyms,
 * mixed-case names (LaTeX, macOS), web and mail addresses, and single letters.
 */
import { nonProse } from "../spellcheck";

export type Word = { from: number; to: number; word: string };

/** Worth looking up: not "AI", "LaTeX", "x". */
export const checkable = (word: string) =>
  word.length > 1 && !/^[A-Z']+$/.test(word) && !/.[A-Z]/.test(word);

const ADDRESS = /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.]+/g;

export function proseWords(text: string): Word[] {
  const skip = [
    ...nonProse(text),
    ...[...text.matchAll(ADDRESS)].map((m): [number, number] => [m.index, m.index + m[0].length]),
  ].sort((a, b) => a[0] - b[0]);
  const words: Word[] = [];
  let k = 0;
  for (const found of text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)) {
    const from = found.index,
      to = from + found[0].length;
    while (k < skip.length && (skip[k]?.[1] ?? 0) <= from) k++;
    if (skip.slice(k).some(([a, b]) => a < to && b > from)) continue;
    if (!checkable(found[0])) continue;
    words.push({ from, to, word: found[0].replace(/’/g, "'") });
  }
  return words;
}
