import { describe, expect, it } from "vitest";
import { compileFailurePrompt } from "./compile-failure";
import type { BuildTarget, TargetBuildResult } from "./types";

const target: BuildTarget = {
  id: "t1",
  name: "Paper",
  mainFile: "paper/main.tex",
  engine: "auto",
  workDir: "paper",
  outputDir: "build",
};
const failed: TargetBuildResult = {
  success: false,
  pdfPath: null,
  pdfRelative: null,
  engine: "xelatex",
  compilerPath: "/usr/bin/latexmk",
  output: "Latexmk: Run number 1\n",
  error: "编译失败或没有生成新 PDF；原 PDF 未替换。",
  log: "! Undefined control sequence.\nl.3 \\foo",
};
const prompt = (result: TargetBuildResult, backend: "opencode" | "codex" = "opencode") =>
  compileFailurePrompt({
    projectPath: "/work",
    target,
    result,
    backend,
    capturedAt: new Date(0),
  });

describe("compileFailurePrompt", () => {
  it("reports the target, the real program and this build's log", () => {
    const text = prompt(failed);
    expect(text).toContain("Main file: paper/main.tex (run from paper, output to build)");
    expect(text).toContain("Program: /usr/bin/latexmk");
    expect(text).toContain("~~~log\n! Undefined control sequence.\nl.3 \\foo\n~~~");
    expect(text).toContain("perplexity_search");
    expect(prompt(failed, "codex")).toContain("Codex web search");
  });

  it("keeps the end of long output and says when no log exists", () => {
    const text = prompt({ ...failed, output: `${"x".repeat(10000)}END`, log: null });
    expect(text).toContain("characters omitted]");
    expect(text).toContain("xEND\n~~~");
    expect(text).not.toContain("x".repeat(6002));
    expect(text).toContain("(The compiler did not write a log.)");
  });
});
