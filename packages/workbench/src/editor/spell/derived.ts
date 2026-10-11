/**
 * Words the dictionary does not list but English builds from words it does. Scientific and
 * technical writing coins them all the time ("composable", "multiscale", "subgraphs",
 * "tokenizers", "codebase"), and a checker that underlines them gets ignored. Each rule takes a
 * word apart into pieces the dictionary knows, and steps aside where the dictionary already
 * spells the word family itself, so that typos ("occured", "trainning", "acceptible",
 * "untill", "statefull") and uncountable plurals ("softwares") are still caught.
 */

/** Science and software vocabulary the rules cannot build, and Latin phrases ("et al."). */
export const EXTRA_WORDS = new Set(
  `
  et al cf viz ibid resp approx eq eqs fig figs sec secs ref refs
  ab initio situ silico vitro vivo priori posteriori novo versa
  agentic softmax logit logits minibatch argmax argmin tanh relu iff wrt
  convolutional deconvolution backpropagation backprop discriminative autoregressive
  heteroscedastic homoscedastic heteroscedasticity spatiotemporal spatio inpainting
  crowdsource crowdsourced crowdsourcing dataset datasets backend backends frontend frontends
  chatbot chatbots keypoint keypoints bandgap bandgaps checksum checksums webpage webpages
  popup popups tooltip tooltips checkbox checkboxes repo repos config configs async enum enums
  init stdout stderr stdin localhost npm runtime runtimes logout signup timestep timesteps
  dataflow dataflows codebase codebases leaderboard leaderboards toolchain toolchains
  physicochemical adsorbate adsorbates desorption sinter sintered sintering dopant dopants
  perovskite perovskites anisotropic anisotropy phonon phonons magnon magnons exciton excitons
  polaron polarons fermion fermions boson bosons spintronics nanosheet nanosheets
  omics genomic genomics proteomic proteomics transcriptomic transcriptomics metabolomic
  metabolomics parametrize parametrized parametrization parametrizations
  pretrain finetune finetunes finetuned finetuning embedder embedders optimizers embeddings
  covariances schemas benchmarked reproducibility replicable replicability tokenizer tokenizers
  workflow workflows multimodal stateful stateless composable
  enthalpy enthalpies exergy entropic isochoric isentropic stoichiometric stoichiometry
  voltammetry chronoamperometry crystallinity diffractogram diffractometer mesoscale
  viscoelastic viscoplastic rheology rheological tribology oligomer ligand chelate isotropy
  ferroelectric pyroelectric quadrupole plasmonic excitonic polariton fermionic bosonic
  perturbative discretization discretize barostat equilibration equilibrate sigmoid allosteric
  transcriptome metabolome genotype mutagenesis cytotoxicity cytotoxic angiogenesis
  immunohistochemistry graphene fullerene chemisorption physisorption desorb inviscid
  incompressible advection radiative emissivity absorptance reflectance birefringence
  orthotropic elastoplastic mesoporous tortuosity wettability amphiphilic surfactant micelle
  solvation solvate protonation deprotonation tautomer enantiomer chiral chirality racemic
  regioselective anharmonic anharmonicity phononic photonic photonics austenite ferrite bainite
  passivation redox potentiostatic galvanostatic coulombic faradaic capacitive pseudocapacitive
  electrolyzer catalytically operando spectrometry chromatographic calorimetry calorimetric
  thermogravimetric interferometry ellipsometry profilometry moduli
  `
    .split(/\s+/)
    .filter(Boolean),
);

/** Nouns without a plural, whose "-s" is a common slip ("softwares", "informations"). */
const UNCOUNTABLE = new Set(
  `software hardware firmware middleware malware information data feedback equipment research
  advice knowledge furniture homework luggage baggage machinery news evidence`.split(/\s+/),
);

/** Productive prefixes of technical English ("un", "in", "en" would make typos valid). */
const PREFIXES =
  `multi non sub inter intra pre post re co de micro macro nano meta hyper super poly bio electro
  photo auto cross over under up down semi pseudo quasi mono thermo geo neuro opto anti counter
  mis ultra trans bi tri uni mid eigen hetero homo iso para`.split(/\s+/);

/** British endings and their American spelling, which the dictionary lists. */
const BRITISH: Array<[RegExp, string]> = [
  [/is(e|ed|es|ing|er|ers|ation|ations)$/, "iz$1"],
  [/ys(e|ed|es|ing|er|ers)$/, "yz$1"],
  [/our(s|ed|ing|ite|ites|able|ful)?$/, "or$1"],
  [/tre(s|d)?$/, "ter$1"],
  [/ll(ed|ing|er|ers)$/, "l$1"],
  [/ogue(s)?$/, "og$1"],
  [/ence(s)?$/, "ense$1"],
];

/** What the dictionary knows: its words (with their own endings) and a root's affix flags. */
export type Dictionary = {
  correct: (word: string) => boolean;
  /** The flags of a root word, or undefined for words that are not roots. */
  flags: (word: string) => string[] | undefined;
};

/**
 * Whether `word` is built from words the dictionary accepts: a prefix, an ending, or two words
 * joined ("workflow"). `depth` bounds the rules applied in a row.
 */
export function derived(word: string, dict: Dictionary, depth = 0): boolean {
  if (depth > 3) return false;
  const w = word.toLowerCase();
  if (EXTRA_WORDS.has(w)) return true;
  const known = (part: string) => dict.correct(part) || EXTRA_WORDS.has(part);
  const ok = (part: string) => known(part) || derived(part, dict, depth + 1);
  const ending = (suffix: string) => (w.endsWith(suffix) ? w.slice(0, -suffix.length) : null);

  // British spellings of words the (American) dictionary has: summarise, colour, centre.
  for (const [pattern, american] of BRITISH) {
    if (!pattern.test(w)) continue;
    const other = w.replace(pattern, american);
    if (other !== w && dict.correct(other)) return true;
  }
  // Possessives, and plurals of nouns the dictionary lists without one.
  const own = ending("'s");
  if (own && ok(own)) return true;
  for (const [suffix, add] of [
    ["ies", "y"],
    ["es", ""],
    ["s", ""],
  ] as const) {
    const stem = ending(suffix);
    if (!stem || stem.length < 3) continue;
    const base = stem + add;
    if (UNCOUNTABLE.has(base)) continue;
    if (dict.correct(base)) {
      const flags = dict.flags(base);
      if (flags && !flags.includes("S")) return true;
    } else if (EXTRA_WORDS.has(base) || derived(base, dict, depth + 1)) return true;
  }
  // Verbs made of nouns ("benchmarking", "checkpointed"), unless the dictionary has the verb.
  for (const suffix of ["ing", "ed"]) {
    const stem = ending(suffix);
    if (!stem || stem.length < 4) continue;
    for (const base of [stem, `${stem}e`]) {
      const verb = [`${base}ed`, `${base}ing`, `${base}d`, `${base.replace(/e$/, "")}ing`].concat(
        /[^aeiou][aeiou][^aeiouwxy]$/.test(base)
          ? [`${base}${base.at(-1)}ed`, `${base}${base.at(-1)}ing`]
          : [],
      );
      if (verb.some((form) => dict.correct(form))) continue;
      if (ok(base)) return true;
    }
  }
  // Agents ("regressor", "denoiser"), unless the dictionary spells the other ending.
  for (const [suffix, rival] of [
    ["er", "or"],
    ["or", "er"],
  ] as const) {
    const stem = ending(suffix);
    if (!stem || stem.length < 3 || dict.correct(stem + rival) || dict.correct(`${stem}e${rival}`))
      continue;
    if (ok(stem) || ok(`${stem}e`)) return true;
  }
  // "-able" and "-ible" from verbs, unless the dictionary has the other one.
  for (const [suffix, rival] of [
    ["able", "ible"],
    ["ible", "able"],
  ] as const) {
    const stem = ending(suffix);
    if (!stem || stem.length < 3 || dict.correct(stem + rival)) continue;
    if (ok(stem) || ok(`${stem}e`) || ok(`${stem}ate`)) return true;
  }
  for (const [suffix, base] of [
    ["ability", "able"],
    ["ibility", "ible"],
    ["ization", "ize"],
    ["isation", "ise"],
    ["izable", "ize"],
    ["izer", "ize"],
    ["ized", "ize"],
    ["izing", "ize"],
  ] as const) {
    const stem = ending(suffix);
    if (stem && stem.length >= 3 && ok(stem + base)) return true;
  }
  const verb = ending("ize");
  if (verb && verb.length >= 5 && (ok(verb) || ok(verb.replace(/y$/, "")))) return true;
  // Qualities of adjectives ("modularity").
  const quality = ending("ity");
  if (quality && /(ar|al|ic|ous|ent|ant|il|ur)$/.test(quality) && ok(quality)) return true;
  for (const suffix of ["ful", "less", "ness", "wise", "like"]) {
    const stem = ending(suffix);
    if (stem && stem.length >= 3 && ok(stem)) return true;
  }

  for (const prefix of PREFIXES) {
    if (!w.startsWith(prefix)) continue;
    const rest = w.slice(prefix.length);
    if (rest.length < 4 || !ok(rest)) continue;
    // "re" goes with verbs ("reweighting", "rerank"): many typos start with it.
    if (prefix !== "re" || verbal(rest, dict)) return true;
  }
  // Two words of four letters or more: "codebase", "timestamps", "dataflow"; not a plural the
  // dictionary refuses ("softwares" is no "soft" and "wares").
  if (depth <= 1 && !dict.correct(w.replace(/s$/, "")) && !dict.correct(w.replace(/es$/, "")))
    for (let at = 4; at <= w.length - 4; at++) {
      const first = w.slice(0, at),
        second = w.slice(at);
      if (/^(well|each|every|ever|never)$/.test(first)) continue;
      if (/^(full|ness|less|able|ment|ally)$/.test(second)) continue;
      if (known(first) && known(second)) return true;
    }
  return false;
}

/** Whether the dictionary inflects `word`, or the root it comes from, as a verb. */
function verbal(word: string, dict: Dictionary) {
  const roots = [word];
  for (const [suffix, add] of [
    ["ing", ""],
    ["ing", "e"],
    ["ed", ""],
    ["ed", "e"],
    ["s", ""],
    ["es", ""],
    ["er", ""],
    ["ers", ""],
    ["ation", ""],
    ["ation", "e"],
  ] as const)
    if (word.endsWith(suffix)) roots.push(word.slice(0, -suffix.length) + add);
  return roots.some((root) => dict.flags(root)?.some((flag) => flag === "D" || flag === "G"));
}
