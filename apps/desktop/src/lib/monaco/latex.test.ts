import type { Monaco } from "@monaco-editor/react";
import type { languages } from "monaco-editor";
import { describe, expect, it } from "vitest";
import { registerLaTeXLanguage } from "./latex";

type TokenizationState = { stack: { state: string } };
type TokenizationResult = {
  tokens: { offset: number; type: string }[];
  endState: TokenizationState;
};

const tokenTypeAt = (result: TokenizationResult, offset: number) => {
  const token = result.tokens.filter(({ offset: start }) => start <= offset).at(-1);
  expect(token).toBeDefined();
  return token?.type;
};

const createTokenizer = async () => {
  let grammar: languages.IMonarchLanguage | undefined;
  const monaco = {
    languages: {
      register: () => {},
      setLanguageConfiguration: () => {},
      setMonarchTokensProvider: (_language: string, provider: languages.IMonarchLanguage) => {
        grammar = provider;
      },
      registerCompletionItemProvider: () => {},
      registerFoldingRangeProvider: () => {},
    },
  } as unknown as Monaco;
  registerLaTeXLanguage(monaco);
  expect(grammar).toBeDefined();

  // Monaco does not publish declaration files for its Monarch internals. Load
  // the real compiler/tokenizer so these tests cover actual state transitions.
  const compilerPath = "monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js";
  const lexerPath = "monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js";
  const [{ compile }, { MonarchTokenizer }] = await Promise.all([
    import(compilerPath),
    import(lexerPath),
  ]);
  const compiledGrammar = compile("latex", grammar);
  const tokenizer = new MonarchTokenizer({}, {}, "latex", compiledGrammar, {
    getValue: () => 20000,
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  }) as {
    getInitialState: () => TokenizationState;
    tokenize: (line: string, hasEOL: boolean, state: TokenizationState) => TokenizationResult;
    dispose: () => void;
  };
  return tokenizer;
};

describe("LaTeX Monarch tokenizer", () => {
  it.each([
    ["without options", "\\usepackage{graphicx}"],
    ["with options", "\\usepackage[draft]{graphicx}"],
    ["document class", "\\documentclass{article}"],
    ["document class with options", "\\documentclass[12pt]{article}"],
  ])("returns to prose after %s", async (_label, command) => {
    const tokenizer = await createTokenizer();
    try {
      const commandLine = tokenizer.tokenize(command, true, tokenizer.getInitialState());
      expect(commandLine.endState.stack.state).toBe("root");

      const prose = tokenizer.tokenize("这段中文应该是普通正文。", true, commandLine.endState);
      expect(prose.endState.stack.state).toBe("root");
      expect(prose.tokens.every(({ type }) => !type.includes("parameter"))).toBe(true);
    } finally {
      tokenizer.dispose();
    }
  });

  it("returns to prose after a multiline package argument", async () => {
    const tokenizer = await createTokenizer();
    try {
      let state = tokenizer.getInitialState();
      for (const line of ["\\usepackage[", "draft", "]{graphicx}"]) {
        state = tokenizer.tokenize(line, true, state).endState;
      }
      expect(state.stack.state).toBe("root");
      const prose = tokenizer.tokenize("接下来的文字保持正文颜色。", true, state);
      expect(prose.tokens.every(({ type }) => !type.includes("parameter"))).toBe(true);
    } finally {
      tokenizer.dispose();
    }
  });

  it.each([
    ["citation", "正文 \\cite{vaspwiki2026convergence} 后文", "vaspwiki2026convergence"],
    ["optional citation", "正文 \\cite[p. 2]{smith2020} 后文", "smith2020"],
    ["natbib citation", "正文 \\citep[see p. 2]{smith2020} 后文", "smith2020"],
    ["cross-reference", "正文 \\ref{sec:intro} 后文", "sec:intro"],
    ["label", "\\label{sec:intro} 正文", "sec:intro"],
  ])("distinguishes the key in a %s from prose", async (_label, line, key) => {
    const tokenizer = await createTokenizer();
    try {
      const result = tokenizer.tokenize(line, true, tokenizer.getInitialState());
      expect(tokenTypeAt(result, line.indexOf(key))).toBe("reference.key.latex");
      expect(result.endState.stack.state).toBe("root");

      const prose = tokenizer.tokenize("下一行是普通正文。", true, result.endState);
      expect(prose.tokens.every(({ type }) => type !== "reference.key.latex")).toBe(true);
    } finally {
      tokenizer.dispose();
    }
  });

  it("highlights each key in a comma-separated citation", async () => {
    const tokenizer = await createTokenizer();
    try {
      const line = "\\cite{first2020,second2021}";
      const result = tokenizer.tokenize(line, true, tokenizer.getInitialState());
      expect(tokenTypeAt(result, line.indexOf("first2020"))).toBe("reference.key.latex");
      expect(tokenTypeAt(result, line.indexOf("second2021"))).toBe("reference.key.latex");
      expect(result.endState.stack.state).toBe("root");
    } finally {
      tokenizer.dispose();
    }
  });

  it("returns to prose after a citation whose note and key span lines", async () => {
    const tokenizer = await createTokenizer();
    try {
      let state = tokenizer.getInitialState();
      for (const line of ["\\cite[see", "p. 2]{"]) {
        state = tokenizer.tokenize(line, true, state).endState;
      }
      const closing = "smith2020} 后面的正文";
      const result = tokenizer.tokenize(closing, true, state);
      expect(tokenTypeAt(result, closing.indexOf("smith2020"))).toBe("reference.key.latex");
      expect(tokenTypeAt(result, closing.indexOf("后面的正文"))).not.toBe("reference.key.latex");
      expect(result.endState.stack.state).toBe("root");
    } finally {
      tokenizer.dispose();
    }
  });

  it("distinguishes table structure from cell prose", async () => {
    const tokenizer = await createTokenizer();
    try {
      const opening = "\\begin{tabular}{lc}";
      const openResult = tokenizer.tokenize(opening, true, tokenizer.getInitialState());
      expect(tokenTypeAt(openResult, opening.indexOf("tabular"))).toBe(
        "entity.name.environment.latex",
      );

      const row = "材料 & 性质 \\\\";
      const rowResult = tokenizer.tokenize(row, true, openResult.endState);
      expect(tokenTypeAt(rowResult, row.indexOf("&"))).toBe("delimiter.table.latex");
      expect(tokenTypeAt(rowResult, row.indexOf("\\\\"))).toBe("delimiter.table.latex");
      expect(tokenTypeAt(rowResult, row.indexOf("材料"))).not.toBe("delimiter.table.latex");

      const closing = "\\end{tabular}";
      const closeResult = tokenizer.tokenize(closing, true, rowResult.endState);
      expect(tokenTypeAt(closeResult, closing.indexOf("tabular"))).toBe(
        "entity.name.environment.latex",
      );
      expect(closeResult.endState.stack.state).toBe("root");
      const prose = tokenizer.tokenize("下一段正文。", true, closeResult.endState);
      expect(prose.tokens.every(({ type }) => type !== "entity.name.environment.latex")).toBe(true);
    } finally {
      tokenizer.dispose();
    }
  });

  it("distinguishes math operators and restores prose after inline math", async () => {
    const tokenizer = await createTokenizer();
    try {
      const line = "计算 $a+b=c$ 得到结果。";
      const result = tokenizer.tokenize(line, true, tokenizer.getInitialState());
      expect(tokenTypeAt(result, line.indexOf("+"))).toBe("operator.math.latex");
      expect(tokenTypeAt(result, line.indexOf("="))).toBe("operator.math.latex");
      expect(result.endState.stack.state).toBe("root");
      expect(tokenTypeAt(result, line.indexOf("得到"))).not.toBe("operator.math.latex");
    } finally {
      tokenizer.dispose();
    }
  });
});
