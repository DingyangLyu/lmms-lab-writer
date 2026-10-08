/**
 * JSON shapes exchanged between the collaboration server and its web client.
 * Both sides import this file, so a changed field fails type checking on both.
 */
import type { ReviewHunk } from "@lmms-lab/writing";

export type Role = "owner" | "editor" | "commenter" | "viewer";
export type PublicUser = { id: string; name: string; admin: boolean; mustChange: boolean };
export type Account = {
  id: string;
  username: string;
  admin: boolean;
  disabled: boolean;
  mustChange: boolean;
  created: number;
  projects: number;
};
export type IssuedPassword = { username?: string; password: string };
/** Returned once when a desktop app signs in; sent as `Authorization: Bearer <token>`. */
export type IssuedToken = { token: string; user: PublicUser };
export type Device = { id: string; name: string; created: number; used: number | null };

export type ProjectSummary = { id: string; name: string; role: Role; created?: number };
export type Member = { id: string; username: string; role: Role };
export type Invite = { token: string; url: string; expiresInDays: number };

export type FileInfo = { id: string; path: string; binary: boolean; revision: number };
export type FileContent = FileInfo & ({ content: string } | { base64: string });
export type SourceFile = { id: string; path: string; content: string; revision: number };

export type Reply = {
  id: string;
  comment: string;
  author: string;
  authorName: string;
  body: string;
  created: number;
};
export type Comment = {
  id: string;
  file: string;
  author: string;
  authorName: string;
  quote: string;
  /** Base64 Yjs relative positions of the selection. */
  start: string;
  end: string;
  body: string;
  resolved: boolean;
  created: number;
  updated: number;
  replies: Reply[];
};

export type Snapshot = {
  id: string;
  label: string;
  author: string;
  created: number;
  manual: boolean;
};
export type SnapshotChange = {
  id: string;
  path: string;
  oldPath?: string;
  binary: boolean;
  status: "added" | "removed" | "changed" | "renamed";
};

export type Proposal = {
  id: string;
  project: string;
  file: string;
  author: string;
  base: string;
  proposed: string;
  hunks: ReviewHunk[];
  revision: number;
  created: number;
};
export type BibliographyImport = {
  added: number;
  skipped: string[];
  renamed: Record<string, string>;
};

export type Engine = "pdflatex" | "xelatex" | "lualatex";
export type BuildIssue = {
  level: "error" | "warning";
  file: string | null;
  line: number | null;
  message: string;
};
export type Build = {
  id: string;
  main: string;
  engine: Engine;
  status: "success" | "failed";
  issues: BuildIssue[];
  log: string;
  pdf: boolean;
  duration: number;
  created: number;
  author: string;
};
/** PDF region in points from the page's top-left corner. */
export type PdfRegion = {
  page: number;
  line?: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type SourceLocation = { file: string; line: number };

/** The server's shared runner, available to every project when the operator configures one. */
export type SharedRunnerInfo = { name: string; capabilities: string[] };
export type SharedJob = {
  id: string;
  author: string;
  prompt: string;
  harness: string;
  status: string;
  result: string;
  created: number;
};
export type RunnerInfo = { id: string; name: string; capabilities: string };
export type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  detail: string;
  created: number;
  name: string | null;
};
export type Created = { id: string };
export type Ok = { ok: true };
