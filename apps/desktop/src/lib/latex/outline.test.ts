import { expect, it } from "vitest";
import { latexOutline } from "./outline";

it("keeps nested headings, multilingual titles and figure/table locations", () => {
  const source = String.raw`\section[Short]{中文 \textbf{引言}}
Text.
\subsection*{
  English background}
\begin{figure*}
\caption[Short]{Results with \textit{two} parts}
\end{figure*}
\begin{table}
\label{tab:results}
\end{table}
\section{Conclusion}`;
  const entries = latexOutline(source);
  expect(entries.map((entry) => entry.title)).toEqual(["中文 引言", "Conclusion"]);
  expect(entries[0]?.children[0]).toMatchObject({ title: "English background", line: 3 });
  expect(entries[0]?.children[0]?.children).toMatchObject([
    { title: "图 · Results with two parts", line: 5, kind: "figure" },
    { title: "表 · tab:results", line: 8, kind: "table" },
  ]);
});

it("ignores comments and literal code without shifting source lines", () => {
  const source = String.raw`% \section{hidden}
\begin{comment}
\section{hidden}
\end{comment}
\verb|\section{hidden}|
\begin{minted}{tex}
\section{hidden}
\end{minted}
\section{100\% reliable}
\input{sections/method}`;
  expect(latexOutline(source)).toMatchObject([
    {
      title: "100% reliable",
      line: 9,
      children: [{ title: "sections/method", line: 10, kind: "include" }],
    },
  ]);
  expect(latexOutline(String.raw`\section{incomplete`)).toEqual([]);
});
