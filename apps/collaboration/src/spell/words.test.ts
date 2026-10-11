import { readFileSync } from "node:fs";
import { join } from "node:path";
import NSpell from "nspell";
import { describe, expect, it } from "vitest";
import { derived } from "./derived";
import { checkable, proseWords } from "./words";

const words = (text: string) => proseWords(text).map((w) => w.word);

describe("spell checking words", () => {
  it("takes the prose and leaves LaTeX, names and addresses alone", () => {
    expect(
      words(
        String.raw`\section{Our metsdhod} We cite~\cite{knuth1984} and see $\alpha x$ % a commment
\includegraphics[width=\linewidth]{figs/plott.pdf} the author’s LaTeX AI macOS at https://exampel.org or a@b.cn`,
      ),
    ).toEqual(["metsdhod", "cite", "and", "see", "the", "author's", "at", "or"]);
    expect([checkable("I"), checkable("NASA"), checkable("OpenFOAM"), checkable("word")]).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("leaves names inside a sentence alone, and checks words that start one", () => {
    expect(words("We use Zotero and Overleaf. Thsi works.\nKohn and Sham agree")).toEqual([
      "We",
      "use",
      "and",
      "Thsi",
      "works",
      "Kohn",
      "and",
      "agree",
    ]);
  });

  const dir = join(import.meta.dirname, "../../node_modules/dictionary-en");
  const spell = NSpell(
    readFileSync(join(dir, "index.aff"), "utf8"),
    readFileSync(join(dir, "index.dic"), "utf8"),
  );
  const roots = (spell as unknown as { data: Record<string, string[] | undefined> }).data;
  const dict = { correct: (w: string) => spell.correct(w), flags: (w: string) => roots[w] };
  const accepted = (w: string) => spell.correct(w) || derived(w, dict);

  it("accepts the words technical writing builds from dictionary words", () => {
    const coined =
      "composable stateful scalable interpretable composability modularity multiscale subgraphs nonconvex interatomic microstructures preprocessing reweighting upsampling tokenizers tokenization embeddings optimizers regressor denoiser benchmarking checkpointing codebase timestamps dataflow hyperparameters eigenstates heterostructure pairwise reimplementation et al";
    expect(coined.split(" ").filter((w) => !accepted(w))).toEqual([]);
  });

  it("still catches typos and plurals of uncountable nouns", () => {
    const typos =
      "untill statefull recieve occured refered prefered transfered trainning acceptible computor writter resluts softwares informations feedbacks datas equipments researchs exasmple metsdhod";
    expect(typos.split(" ").filter(accepted)).toEqual([]);
  });

  it("finds the misspellings with the dictionary the page loads", () => {
    const text = "We tested the metsdhod and anotehr wrod in the author's paper.";
    expect(words(text).filter((w) => !spell.correct(w))).toEqual(["metsdhod", "anotehr", "wrod"]);
    expect(spell.suggest("anotehr")).toContain("another");
  });
});
