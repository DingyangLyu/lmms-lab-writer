/**
 * The symbol palette's symbols, after Overleaf's: what each looks like, the command that writes
 * it, and words to find it by. Most are for math mode; `text` marks the ones that are not.
 */
export type SymbolCategory = "greek" | "arrows" | "operators" | "relations" | "misc";
export type LatexSymbol = {
  glyph: string;
  command: string;
  category: SymbolCategory;
  /** Extra words to search by, beyond the command's name. */
  words?: string;
  /** Needs a package (shown as a hint). */
  package?: string;
  /** Usable outside math mode. */
  text?: boolean;
};

const greek: Array<[string, string, string?]> = [
  ["α", "alpha"],
  ["β", "beta"],
  ["γ", "gamma"],
  ["δ", "delta"],
  ["ϵ", "epsilon"],
  ["ε", "varepsilon"],
  ["ζ", "zeta"],
  ["η", "eta"],
  ["θ", "theta"],
  ["ϑ", "vartheta"],
  ["ι", "iota"],
  ["κ", "kappa"],
  ["λ", "lambda"],
  ["μ", "mu"],
  ["ν", "nu"],
  ["ξ", "xi"],
  ["π", "pi"],
  ["ϖ", "varpi"],
  ["ρ", "rho"],
  ["ϱ", "varrho"],
  ["σ", "sigma"],
  ["ς", "varsigma"],
  ["τ", "tau"],
  ["υ", "upsilon"],
  ["ϕ", "phi"],
  ["φ", "varphi"],
  ["χ", "chi"],
  ["ψ", "psi"],
  ["ω", "omega"],
  ["Γ", "Gamma"],
  ["Δ", "Delta"],
  ["Θ", "Theta"],
  ["Λ", "Lambda"],
  ["Ξ", "Xi"],
  ["Π", "Pi"],
  ["Σ", "Sigma"],
  ["Υ", "Upsilon"],
  ["Φ", "Phi"],
  ["Ψ", "Psi"],
  ["Ω", "Omega"],
];
const arrows: Array<[string, string, string?]> = [
  ["←", "leftarrow", "left"],
  ["→", "rightarrow", "right to"],
  ["↑", "uparrow", "up"],
  ["↓", "downarrow", "down"],
  ["↔", "leftrightarrow"],
  ["↕", "updownarrow"],
  ["⇐", "Leftarrow"],
  ["⇒", "Rightarrow", "implies"],
  ["⇑", "Uparrow"],
  ["⇓", "Downarrow"],
  ["⇔", "Leftrightarrow", "iff"],
  ["⟵", "longleftarrow"],
  ["⟶", "longrightarrow"],
  ["⟹", "Longrightarrow"],
  ["⟺", "Longleftrightarrow"],
  ["↦", "mapsto", "maps"],
  ["⟼", "longmapsto"],
  ["↗", "nearrow"],
  ["↘", "searrow"],
  ["↙", "swarrow"],
  ["↖", "nwarrow"],
  ["↪", "hookrightarrow"],
  ["↩", "hookleftarrow"],
  ["⇌", "rightleftharpoons", "equilibrium"],
  ["⇀", "rightharpoonup"],
  ["↼", "leftharpoonup"],
  ["↠", "twoheadrightarrow", "surjection"],
];
const operators: Array<[string, string, string?]> = [
  ["±", "pm", "plus minus"],
  ["∓", "mp"],
  ["×", "times", "multiply cross"],
  ["÷", "div", "divide"],
  ["·", "cdot", "dot multiply"],
  ["∗", "ast"],
  ["⋆", "star"],
  ["∘", "circ", "compose"],
  ["•", "bullet"],
  ["⊕", "oplus"],
  ["⊖", "ominus"],
  ["⊗", "otimes", "tensor"],
  ["⊙", "odot"],
  ["∩", "cap", "intersection"],
  ["∪", "cup", "union"],
  ["⊓", "sqcap"],
  ["⊔", "sqcup"],
  ["∧", "wedge", "and"],
  ["∨", "vee", "or"],
  ["∖", "setminus"],
  ["∑", "sum"],
  ["∏", "prod", "product"],
  ["∐", "coprod"],
  ["∫", "int", "integral"],
  ["∬", "iint", "double integral"],
  ["∮", "oint", "contour integral"],
  ["⋂", "bigcap"],
  ["⋃", "bigcup"],
  ["⨁", "bigoplus"],
  ["⨂", "bigotimes"],
  ["√", "sqrt{}", "square root"],
  ["∂", "partial", "derivative"],
  ["∇", "nabla", "gradient del"],
  ["′", "prime"],
  ["†", "dagger"],
  ["‡", "ddagger"],
];
const relations: Array<[string, string, string?]> = [
  ["≤", "leq", "less equal"],
  ["≥", "geq", "greater equal"],
  ["≠", "neq", "not equal"],
  ["≈", "approx", "approximately"],
  ["≡", "equiv", "equivalent"],
  ["≅", "cong"],
  ["∼", "sim", "similar"],
  ["≃", "simeq"],
  ["∝", "propto", "proportional"],
  ["≪", "ll", "much less"],
  ["≫", "gg", "much greater"],
  ["≺", "prec"],
  ["≻", "succ"],
  ["⪯", "preceq"],
  ["⪰", "succeq"],
  ["∈", "in", "element member"],
  ["∉", "notin"],
  ["∋", "ni"],
  ["⊂", "subset"],
  ["⊃", "supset"],
  ["⊆", "subseteq"],
  ["⊇", "supseteq"],
  ["⊊", "subsetneq"],
  ["⊥", "perp", "perpendicular"],
  ["∥", "parallel"],
  ["∣", "mid", "divides"],
  ["⊢", "vdash"],
  ["⊨", "models"],
  ["≐", "doteq"],
  ["≜", "triangleq", "defined"],
  ["≔", "coloneqq", "define assign"],
];
const misc: Array<[string, string, string?]> = [
  ["∞", "infty", "infinity"],
  ["∀", "forall", "for all"],
  ["∃", "exists"],
  ["∄", "nexists"],
  ["¬", "neg", "not"],
  ["∅", "emptyset", "empty set"],
  ["∅", "varnothing", "empty set"],
  ["ℏ", "hbar", "planck"],
  ["ℓ", "ell"],
  ["ℜ", "Re", "real part"],
  ["ℑ", "Im", "imaginary part"],
  ["℘", "wp"],
  ["ℵ", "aleph"],
  ["∠", "angle"],
  ["△", "triangle"],
  ["□", "square"],
  ["◇", "diamond"],
  ["⋯", "cdots", "dots"],
  ["…", "ldots", "dots ellipsis"],
  ["⋮", "vdots"],
  ["⋱", "ddots"],
  ["♯", "sharp"],
  ["♭", "flat"],
  ["♮", "natural"],
  ["⊤", "top"],
  ["⊥", "bot"],
  ["∴", "therefore"],
  ["∵", "because"],
];
/** Commands that need a package: the package's name. */
const NEEDS: Record<string, string> = {
  coloneqq: "mathtools",
  iint: "amsmath",
  nexists: "amssymb",
  varnothing: "amssymb",
  square: "amssymb",
  therefore: "amssymb",
  because: "amssymb",
  subsetneq: "amssymb",
  twoheadrightarrow: "amssymb",
  triangleq: "amssymb",
  preceq: "amssymb",
  succeq: "amssymb",
  longmapsto: "amsmath",
};
const fromList = (category: SymbolCategory, list: Array<[string, string, string?]>) =>
  list.map(
    ([glyph, name, words]): LatexSymbol => ({
      glyph,
      command: `\\${name}`,
      category,
      words,
      package: NEEDS[name.replace("{}", "")],
    }),
  );
/** Text-mode extras that writers often look for. */
const text: LatexSymbol[] = [
  { glyph: "§", command: "\\S", category: "misc", words: "section sign", text: true },
  { glyph: "¶", command: "\\P", category: "misc", words: "paragraph", text: true },
  { glyph: "©", command: "\\copyright", category: "misc", words: "copyright", text: true },
  { glyph: "°", command: "^{\\circ}", category: "misc", words: "degree celsius" },
  { glyph: "–", command: "--", category: "misc", words: "en dash range", text: true },
  { glyph: "—", command: "---", category: "misc", words: "em dash", text: true },
  {
    glyph: "ℝ",
    command: "\\mathbb{R}",
    category: "misc",
    words: "real numbers",
    package: "amssymb",
  },
  {
    glyph: "ℕ",
    command: "\\mathbb{N}",
    category: "misc",
    words: "natural numbers",
    package: "amssymb",
  },
  { glyph: "ℤ", command: "\\mathbb{Z}", category: "misc", words: "integers", package: "amssymb" },
  { glyph: "ℚ", command: "\\mathbb{Q}", category: "misc", words: "rationals", package: "amssymb" },
  {
    glyph: "ℂ",
    command: "\\mathbb{C}",
    category: "misc",
    words: "complex numbers",
    package: "amssymb",
  },
];

export const LATEX_SYMBOLS: LatexSymbol[] = [
  ...fromList("greek", greek),
  ...fromList("arrows", arrows),
  ...fromList("operators", operators),
  ...fromList("relations", relations),
  ...fromList("misc", misc),
  ...text,
];

/** Symbols matching a search: by command, glyph or the words listed for them. */
export function findSymbols(query: string, category?: SymbolCategory) {
  const q = query.trim().toLowerCase().replace(/^\\/, "");
  return LATEX_SYMBOLS.filter(
    (s) =>
      (!category || s.category === category) &&
      (!q ||
        s.glyph === query.trim() ||
        s.command.toLowerCase().includes(q) ||
        (s.words ?? "").toLowerCase().includes(q)),
  );
}

/** What the palette writes: the command, with a space when a letter follows it. */
export function symbolInsertion(command: string, next: string) {
  return /^\\[A-Za-z]+$/.test(command) && /^[A-Za-z]/.test(next) ? `${command} ` : command;
}
