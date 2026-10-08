export type LaTeXCompiler = "pdflatex" | "xelatex" | "lualatex" | "latexmk" | "tectonic";

export interface CompilerInfo {
  name: string;
  path: string | null;
  available: boolean;
  version: string | null;
}

export interface LaTeXCompilersStatus {
  pdflatex: CompilerInfo;
  xelatex: CompilerInfo;
  lualatex: CompilerInfo;
  latexmk: CompilerInfo;
  tectonic: CompilerInfo;
}

export interface BuildTarget {
  id: string;
  name: string;
  mainFile: string;
  engine: LaTeXCompiler | "auto";
  workDir: string;
  outputDir: string;
}
export interface ProjectBuildConfig {
  version: 1;
  activeTarget: string | null;
  targets: BuildTarget[];
}
export interface LaTeXSettings {
  mainFile: string | null;
  config: ProjectBuildConfig;
}
export interface TargetBuildResult {
  success: boolean;
  pdfPath: string | null;
  pdfRelative: string | null;
  engine: string;
  compilerPath: string;
  output: string;
  error: string | null;
  /** Tail of the TeX log when the build failed. */
  log?: string | null;
}

export type CompilationStatus = "idle" | "compiling" | "success" | "error";

export interface CompilationResult {
  success: boolean;
  exit_code: number | null;
  pdf_path: string | null;
  error: string | null;
}

export interface CompileOutputEvent {
  line: string;
  is_error: boolean;
  is_warning: boolean;
}

export const DEFAULT_LATEX_SETTINGS: LaTeXSettings = {
  mainFile: null,
  config: { version: 1, activeTarget: null, targets: [] },
};

// LaTeX Installation Types
export interface LaTeXDistribution {
  name: string;
  id: string;
  description: string;
  install_command: string | null;
  download_url: string | null;
}

export interface InstallProgress {
  stage: "starting" | "checking" | "downloading" | "installing" | "complete" | "error";
  message: string;
  progress: number | null;
}

export interface InstallResult {
  success: boolean;
  message: string;
  needs_restart: boolean;
}

// SyncTeX inverse search result
export interface SynctexResult {
  file: string;
  line: number;
  column: number;
}

// Main file detection types
