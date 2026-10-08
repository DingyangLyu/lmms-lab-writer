import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippetCompletion,
} from "@codemirror/autocomplete";
import { i18n } from "./i18n";

/** Project-wide knowledge the editor cannot see in the open file. */
export type ProjectHints = {
  citations: { key: string; title: string }[];
  labels: string[];
};

const environments = [
  "equation",
  "equation*",
  "align",
  "align*",
  "figure",
  "figure*",
  "table",
  "table*",
  "tabular",
  "itemize",
  "enumerate",
  "description",
  "abstract",
  "center",
  "minipage",
  "theorem",
  "lemma",
  "proof",
  "definition",
  "algorithm",
  "verbatim",
];
const commandList = (): Completion[] =>
  [
    snippetCompletion(`\\section{\${title}}`, {
      label: "\\section",
      detail: i18n.t("complete.section"),
    }),
    snippetCompletion(`\\subsection{\${title}}`, {
      label: "\\subsection",
      detail: i18n.t("complete.subsection"),
    }),
    snippetCompletion(`\\subsubsection{\${title}}`, { label: "\\subsubsection" }),
    snippetCompletion(`\\paragraph{\${title}}`, { label: "\\paragraph" }),
    snippetCompletion(`\\begin{\${environment}}\n\t\${}\n\\end{\${environment}}`, {
      label: "\\begin",
      detail: i18n.t("complete.environment"),
    }),
    snippetCompletion(`\\cite{\${key}}`, { label: "\\cite", detail: i18n.t("complete.cite") }),
    snippetCompletion(`\\citep{\${key}}`, { label: "\\citep" }),
    snippetCompletion(`\\citet{\${key}}`, { label: "\\citet" }),
    snippetCompletion(`\\ref{\${label}}`, { label: "\\ref", detail: i18n.t("complete.ref") }),
    snippetCompletion(`\\eqref{\${label}}`, { label: "\\eqref" }),
    snippetCompletion(`\\autoref{\${label}}`, { label: "\\autoref" }),
    snippetCompletion(`\\label{\${label}}`, { label: "\\label" }),
    snippetCompletion(`\\textbf{\${text}}`, { label: "\\textbf", detail: i18n.t("complete.bold") }),
    snippetCompletion(`\\textit{\${text}}`, {
      label: "\\textit",
      detail: i18n.t("complete.italic"),
    }),
    snippetCompletion(`\\emph{\${text}}`, { label: "\\emph" }),
    snippetCompletion(`\\texttt{\${text}}`, { label: "\\texttt" }),
    snippetCompletion(`\\underline{\${text}}`, { label: "\\underline" }),
    snippetCompletion(`\\footnote{\${text}}`, {
      label: "\\footnote",
      detail: i18n.t("complete.footnote"),
    }),
    snippetCompletion(`\\url{\${url}}`, { label: "\\url" }),
    snippetCompletion(`\\href{\${url}}{\${text}}`, { label: "\\href" }),
    snippetCompletion(`\\includegraphics[width=\${0.8}\\linewidth]{\${file}}`, {
      label: "\\includegraphics",
      detail: i18n.t("complete.figure"),
    }),
    snippetCompletion(`\\caption{\${text}}`, { label: "\\caption" }),
    snippetCompletion(`\\frac{\${a}}{\${b}}`, {
      label: "\\frac",
      detail: i18n.t("complete.fraction"),
    }),
    snippetCompletion(`\\sqrt{\${x}}`, { label: "\\sqrt" }),
    snippetCompletion(`\\mathbf{\${x}}`, { label: "\\mathbf" }),
    snippetCompletion(`\\mathrm{\${x}}`, { label: "\\mathrm" }),
    snippetCompletion(`\\mathcal{\${x}}`, { label: "\\mathcal" }),
    snippetCompletion(`\\usepackage{\${package}}`, {
      label: "\\usepackage",
      detail: i18n.t("complete.package"),
    }),
    snippetCompletion(`\\input{\${file}}`, { label: "\\input" }),
    snippetCompletion(`\\include{\${file}}`, { label: "\\include" }),
    snippetCompletion(`\\newcommand{\\\${name}}{\${definition}}`, { label: "\\newcommand" }),
    ...[
      "\\item",
      "\\centering",
      "\\maketitle",
      "\\tableofcontents",
      "\\newpage",
      "\\clearpage",
      "\\noindent",
      "\\hline",
      "\\toprule",
      "\\midrule",
      "\\bottomrule",
      "\\left",
      "\\right",
      "\\alpha",
      "\\beta",
      "\\gamma",
      "\\delta",
      "\\epsilon",
      "\\theta",
      "\\lambda",
      "\\mu",
      "\\sigma",
      "\\sum",
      "\\int",
      "\\infty",
      "\\partial",
      "\\cdot",
      "\\times",
      "\\leq",
      "\\geq",
      "\\approx",
    ].map((label) => ({ label, type: "keyword" })),
  ].map((c) => ({ type: "function", ...c }));
/** Built in the interface language, again only when it changes. */
let built: { locale: string; list: Completion[] } | null = null;
function commands() {
  const locale = i18n.getLocale();
  if (built?.locale !== locale) built = { locale, list: commandList() };
  return built.list;
}
const labelPattern = /\\label\{([^{}]+)\}/g;
const labelsIn = (text: string) => [...text.matchAll(labelPattern)].map((m) => m[1] ?? "");

/** Commands, environments, citation keys from .bib files and labels from every .tex file. */
export function latexCompletion(hints: () => ProjectHints) {
  return (context: CompletionContext): CompletionResult | null => {
    const cite = context.matchBefore(/\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\])*\{[^{}]*/);
    if (cite) {
      const start = Math.max(cite.text.lastIndexOf("{"), cite.text.lastIndexOf(",")) + 1;
      const typed = cite.text.slice(start);
      return {
        from: cite.from + start + (typed.length - typed.trimStart().length),
        options: hints().citations.map((c) => ({
          label: c.key,
          detail: c.title.slice(0, 60),
          type: "variable",
        })),
        validFor: /^[^,}\s]*$/,
      };
    }
    const ref = context.matchBefore(/\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref)\{[^{}]*/);
    if (ref) {
      const labels = new Set([...hints().labels, ...labelsIn(context.state.doc.toString())]);
      return {
        from: ref.from + ref.text.indexOf("{") + 1,
        options: [...labels].filter(Boolean).map((label) => ({ label, type: "constant" })),
        validFor: /^[^}]*$/,
      };
    }
    const environment = context.matchBefore(/\\(?:begin|end)\{[A-Za-z*]*/);
    if (environment)
      return {
        from: environment.from + environment.text.indexOf("{") + 1,
        options: environments.map((label) => ({ label, type: "type" })),
        validFor: /^[A-Za-z*]*$/,
      };
    const command = context.matchBefore(/\\[A-Za-z]*/);
    if (!command || (command.text.length < 2 && !context.explicit)) return null;
    return { from: command.from, options: commands(), validFor: /^\\[A-Za-z]*$/ };
  };
}

/** Citation keys and labels collected from the project's text files. */
export function projectHints(
  sources: { path: string; content: string }[],
  parse: (bib: string) => {
    entries: { key: string; fields: Record<string, string> }[];
  },
): ProjectHints {
  return {
    citations: sources
      .filter((f) => f.path.endsWith(".bib"))
      .flatMap((f) => parse(f.content).entries)
      .map((e) => ({ key: e.key, title: (e.fields.title ?? "").replace(/[{}]/g, "") })),
    labels: sources.filter((f) => f.path.endsWith(".tex")).flatMap((f) => labelsIn(f.content)),
  };
}
