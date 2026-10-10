import { describe, expect, it } from "vitest";
import { stripComments, wordCount } from "./word-count";

const files: Record<string, string> = {
  "main.tex": String.raw`\documentclass{article}
\usepackage{amsmath} % not counted
\title{Ignored title}
\begin{document}
\section{Introduction}
We study heat flow in thin films~\cite{knuth1984}. See Section~\ref{sec:m}.
% A comment with many words that must not count
The energy $E = mc^2$ and \(x\) appear inline.
\begin{equation}
  G = H - TS
\end{equation}
\input{sections/method}
\begin{figure}[htbp]
  \includegraphics[width=\linewidth]{figures/plot.pdf}
  \caption{A plot of the \textbf{results}.}
\end{figure}
\href{https://example.com}{Our website} has data; 100\% of it.
\begin{thebibliography}{9}\bibitem{knuth1984} Knuth, The TeXbook.\end{thebibliography}
\end{document}`,
  "sections/method.tex": String.raw`\subsection{Method}\label{sec:m}
我们提出一种方法。
\[ a^2 + b^2 = c^2 \]`,
};
const read = (path: string) => files[path] ?? null;

describe("word count", () => {
  it("counts the text, headings, captions and formulas of the document and its inputs", () => {
    expect(wordCount("main.tex", read)).toEqual({
      // We study heat flow in thin films . See Section . (9) The energy and appear inline. (5)
      // Our website has data; 100 of it. (7)
      words: 21,
      characters: 8,
      headers: 2,
      headerWords: 2,
      captions: 1,
      captionWords: 5,
      inlineMath: 2,
      displayMath: 2,
      files: ["main.tex", "sections/method.tex"],
    });
  });
  it("leaves escaped percent signs, and ignores missing or circular inputs", () => {
    expect(stripComments("50\\% done % note")).toBe("50\\% done ");
    const loop = {
      "a.tex": "\\begin{document}one \\input{b} \\input{gone}\\end{document}",
      "b.tex": "two \\input{a}",
    };
    const result = wordCount("a.tex", (p) => loop[p as keyof typeof loop] ?? null);
    expect([result.words, result.files]).toEqual([2, ["a.tex", "b.tex"]]);
  });
});
