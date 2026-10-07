import type { BuildTarget, TargetBuildResult } from "./types";

const OUTPUT_LIMIT = 6000;
const LOG_LIMIT = 12000;

function tail(text: string, limit: number) {
  return text.length > limit
    ? `[first ${text.length - limit} characters omitted]\n${text.slice(-limit)}`
    : text;
}

/** The message that hands a failed build to the coding agent. */
export function compileFailurePrompt({
  projectPath,
  target,
  result,
  backend,
  capturedAt = new Date(),
}: {
  projectPath: string;
  target: BuildTarget;
  result: TargetBuildResult;
  backend: "opencode" | "codex" | "claude";
  capturedAt?: Date;
}) {
  return [
    "Local LaTeX compilation failed. Please diagnose and fix this project.",
    "",
    `Captured at: ${capturedAt.toISOString()}`,
    `Project directory: ${projectPath}`,
    `Build target: ${target.name}`,
    `Main file: ${target.mainFile} (run from ${target.workDir || "."}, output to ${target.outputDir || "."})`,
    `Engine: ${result.engine}`,
    `Program: ${result.compilerPath || "(not resolved)"}`,
    `Reported error: ${result.error || "compilation failed"}`,
    "",
    "Compiler output (tail):",
    "~~~text",
    tail(result.output.trim(), OUTPUT_LIMIT) || "(No output was captured.)",
    "~~~",
    "",
    "LaTeX log (tail):",
    "~~~log",
    result.log?.trim() ? tail(result.log, LOG_LIMIT) : "(The compiler did not write a log.)",
    "~~~",
    "",
    backend === "codex"
      ? "If current package documentation or a web-only error is relevant, use Codex web search and verify source URLs before relying on them."
      : "If the error depends on current package documentation, class behavior, or a web-only error message, use perplexity_search when available, websearch for discovery, and webfetch for source URLs. If websearch returns a 429 from Exa, fall back to perplexity_search or webfetch.",
    "Please inspect the relevant .tex, .bib, .sty, and .cls files, make the minimal fix needed to compile, rerun the local compilation, and summarize what changed.",
  ].join("\n");
}
