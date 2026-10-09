"use client";

import {
  basename as tauriBasename,
  dirname as tauriDirname,
  extname as tauriExtname,
  join as tauriJoin,
  normalize as tauriNormalize,
  sep as tauriSep,
} from "@tauri-apps/api/path";

// Re-export async Tauri path functions
export const basename = tauriBasename;
export const dirname = tauriDirname;
export const join = tauriJoin;
export const normalize = tauriNormalize;
export const extname = tauriExtname;
export const sep = tauriSep;

export { lineEndings, pathSync, pathsEqual } from "@lmms-lab/workbench";
