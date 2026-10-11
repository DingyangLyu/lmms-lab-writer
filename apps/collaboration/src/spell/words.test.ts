import { readFileSync } from "node:fs";
import { join } from "node:path";
import NSpell from "nspell";
import { describe, expect, it } from "vitest";
import { checkable, proseWords } from "./words";

const words = (text: string) => proseWords(text).map((w) => w.word);

describe("spell checking words", () => {
  it("takes the prose and leaves LaTeX, names and addresses alone", () => {
    expect(
      words(
        String.raw`\section{Our metsdhod} We cite~\cite{knuth1984} and see $\alpha x$ % a commment
\includegraphics[width=\linewidth]{figs/plott.pdf} the author’s LaTeX AI macOS at https://exampel.org or a@b.cn`,
      ),
    ).toEqual(["Our", "metsdhod", "We", "cite", "and", "see", "the", "author's", "at", "or"]);
    expect([checkable("I"), checkable("NASA"), checkable("OpenFOAM"), checkable("word")]).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("finds the misspellings with the dictionary the page loads", () => {
    const dir = join(import.meta.dirname, "../../node_modules/dictionary-en");
    const spell = NSpell(
      readFileSync(join(dir, "index.aff"), "utf8"),
      readFileSync(join(dir, "index.dic"), "utf8"),
    );
    const text = "We tested the metsdhod and anotehr wrod in the author's paper.";
    expect(words(text).filter((w) => !spell.correct(w))).toEqual(["metsdhod", "anotehr", "wrod"]);
    expect(spell.suggest("anotehr")).toContain("another");
  });
});
