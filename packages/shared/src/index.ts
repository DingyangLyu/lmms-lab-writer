/** Types shared between the desktop frontend and its Rust commands' JSON. */

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface GitInfo {
  branch: string;
  isDirty: boolean;
  lastCommit?: {
    hash: string;
    message: string;
    date: string;
  };
  remote?: {
    name: string;
    url: string;
  };
  ahead?: number;
  behind?: number;
}

export interface GitFileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  remote?: string;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  hasCommits: boolean;
  changes: GitFileChange[];
  isRepo: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}
