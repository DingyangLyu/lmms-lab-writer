import { describe, expect, it } from "vitest";
import { nonProse } from "./spellcheck";

/** The text the checker still sees, with the skipped parts replaced by a bar. */
function prose(text: string) {
  let out = "",
    at = 0;
  for (const [from, to] of nonProse(text)) {
    out += `${text.slice(at, from)}|`;
    at = to;
  }
  return out + text.slice(at);
}

describe("nonProse", () => {
  it("keeps the prose of headings and emphasis, not the commands", () => {
    expect(prose(String.raw`\section{Introductoin} We \emph{stuyd} heat.`)).toBe(
      "|{Introductoin} We |{stuyd} heat.",
    );
  });

  it("skips citation, reference and label keys and options", () => {
    expect(prose(String.raw`As shown~\citep[p.~3]{knth1984,lamprt} in Fig.~\ref{fig:pltt}.`)).toBe(
      "As shown~| in Fig.~|.",
    );
    expect(prose(String.raw`\label{sec:intro}Text`)).toBe("|Text");
  });

  it("skips math, inline and displayed", () => {
    expect(prose(String.raw`Energy $E = mc^2$ and \(x\) and \[ab\] and $$cd$$ here.`)).toBe(
      "Energy | and | and | and | here.",
    );
    expect(prose("Price is 5\\$ and $x$.")).toBe("Price is 5| and |.");
    expect(
      prose(String.raw`Before
\begin{align*}
  \mathrm{foo} &= bar
\end{align*}
after`),
    ).toBe("Before\n|\nafter");
  });

  it("skips comments, verbatim and file names", () => {
    expect(prose("Text % a commnet\nmore")).toBe("Text |\nmore");
    expect(prose("100\\% sure")).toBe("100| sure");
    expect(prose(String.raw`See \verb|fooo bar| now`)).toBe("See | now");
    expect(prose(String.raw`\includegraphics[width=\linewidth]{figs/plt.pdf}`)).toBe("|");
    expect(
      prose(String.raw`\begin{lstlisting}
int mian() {}
\end{lstlisting}`),
    ).toBe("|");
  });

  it("skips environment names and tabular column specs", () => {
    expect(
      prose(String.raw`\begin{tabular}{lcr}
a & b \\
\end{tabular}`),
    ).toBe("|\na & b |\n|");
  });

  it("returns sorted ranges that do not overlap", () => {
    const ranges = nonProse(String.raw`$\cite{x}$ \ref{a}\label{b} % \cite{y}`);
    for (let i = 1; i < ranges.length; i++)
      expect(ranges[i]?.[0]).toBeGreaterThan(ranges[i - 1]?.[1] ?? 0);
  });
});
