/**
 * JSON shapes exchanged between the collaboration server and its web client.
 * Both sides import this file, so a changed field fails type checking on both.
 */
import type { ReviewHunk } from "@lmms-lab/writing";

export type Role = "owner" | "editor" | "commenter" | "viewer";
export type PublicUser = {
  id: string;
  name: string;
  admin: boolean;
  mustChange: boolean;
  /** The profile picture's version (`/api/users/:id/avatar?v=`), or null without one. */
  avatar: number | null;
};
/** Someone as lists show them: name and picture. */
export type Person = { id: string; username: string; avatar: number | null };
/** Friends, and requests waiting on either side. */
export type Friends = { friends: Person[]; incoming: Person[]; outgoing: Person[] };
/** A user found by name, with where they stand with the one searching. */
export type FoundUser = Person & { relation: "friend" | "incoming" | "outgoing" | "none" };
/** Registration or invitation outcome: signed in, or waiting for an administrator. */
export type Registered = { pending: true } | { pending: false; user: PublicUser };
export type RegistrationMode = "approval" | "open" | "closed";
export type RegistrationInfo = { mode: RegistrationMode; invite: boolean };
export type Account = {
  id: string;
  username: string;
  admin: boolean;
  disabled: boolean;
  mustChange: boolean;
  /** Registered and waiting for an administrator's approval. */
  pending: boolean;
  /** What the person wrote when registering. */
  note: string;
  created: number;
  projects: number;
  /** Projects this account owns alone; deleting it hands them to the deleting administrator. */
  soleOwned: number;
};
export type SignupInvite = {
  id: string;
  note: string;
  created: number;
  expires: number;
  uses: number;
  used: number;
  createdBy: string | null;
};
export type IssuedSignupInvite = SignupInvite & { token: string; url: string };
export type IssuedPassword = { username?: string; password: string };
/** Returned once when a desktop app signs in; sent as `Authorization: Bearer <token>`. */
export type IssuedToken = { token: string; user: PublicUser };
export type Device = { id: string; name: string; created: number; used: number | null };

export type ProjectSummary = {
  id: string;
  name: string;
  role: Role;
  created?: number;
  /** Latest change to files, comments or settings. */
  updated?: number;
  /** An owner's username, for the dashboard's owner column. */
  owner?: string;
  ownerId?: string;
  ownerAvatar?: number | null;
  /** Archive and trash are each member's own view; they hide nothing from the others. */
  archived?: boolean;
  trashed?: boolean;
};
/** A starting point for a new project (see server/templates.ts). */
/** Template categories, as the gallery groups them. */
export const templateCategories = [
  "conference",
  "journal",
  "preprint",
  "paper",
  "thesis",
  "presentation",
  "basic",
  "other",
] as const;
/** Research fields a template is used in. */
export const templateFields = ["ml", "cv", "nlp", "ai", "data", "robotics", "speech"] as const;
export type Localized = { zh: string; en: string };
export type TemplateInfo = {
  id: string;
  name: Localized;
  description: Localized;
  category: string;
  main: string;
  engine: Engine;
  order: number;
  /** A preview image exists (`/api/templates/:id/preview`). */
  preview: boolean;
  fileCount: number;
  /** Bytes of the template's files. */
  bytes: number;
  /** The conference or journal, e.g. "NeurIPS", and its year. */
  venue: string | null;
  year: number | null;
  /** Other venues that use the same format, e.g. EMNLP for the ACL template. */
  venues: string[];
  fields: string[];
  tags: string[];
  /** The official author kit, and the venue's call for papers. */
  source: string | null;
  homepage: string | null;
  /** Pages rendered from the sample PDF (`/api/templates/:id/pages/:n`), and the PDF itself. */
  pages: number;
  pdf: boolean;
  /** "pending" while a member's new template is being built; "failed" when TeX gave up. */
  previewStatus: "ready" | "pending" | "failed" | "none";
  /** Shipped with Writer, from the official kits, or published by a member. */
  origin: "builtin" | "official" | "member";
  author: { id: string; name: string } | null;
  /** When the files were last fetched or published (ms). */
  updated: number | null;
};
export type TemplateList = {
  templates: TemplateInfo[];
  /** The template library's folder (it may be on a removable disk), and whether it can be written. */
  library: { available: boolean; writable: boolean };
};
/** A desktop installer the server offers (WRITER_DOWNLOADS_DIR). */
export type DesktopInstaller = {
  name: string;
  platform: "macos" | "windows" | "linux";
  /** Apple silicon / ARM, or Intel and AMD; null when the name does not say. */
  arch: "arm64" | "x64" | null;
  kind: "pkg" | "dmg" | "exe" | "msi" | "appimage" | "deb" | "rpm";
  bytes: number;
  updated: number;
};
export type DesktopDownloads = { version: string | null; installers: DesktopInstaller[] };
export type TemplateDetail = TemplateInfo & {
  files: Array<{ path: string; bytes: number }>;
  /** The end of the TeX log when the preview failed. */
  previewLog: string | null;
};
/** What a member enters to publish a project as a template. */
export type TemplateInput = {
  name: Localized;
  description: Localized;
  category: string;
  fields: string[];
  tags: string[];
  venue: string | null;
  year: number | null;
};
/** A project made from an uploaded zip, with the entries that were left out. */
export type ImportedProject = ProjectSummary & { skipped: string[] };
export type Member = { id: string; username: string; role: Role; avatar: number | null };
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
  /** When the author last changed the text. */
  edited: number | null;
};
/** Where on the compiled PDF a comment was made, to draw it on that PDF again. */
export type CommentPdf = {
  /** PDF.js fingerprint of the PDF the selection was made on. */
  fingerprint: string;
  style: "highlight" | "underline";
  /** Rectangles as fractions of their page, top-left origin. */
  marks: Array<{ page: number; x: number; y: number; width: number; height: number }>;
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
  edited: number | null;
  /** The anchored text's current offsets in the file and its first line; null once deleted. */
  from: number | null;
  to: number | null;
  line: number | null;
  /** The anchored source text now (at most 4000 characters), to check a local copy against. */
  excerpt: string | null;
  pdf: CommentPdf | null;
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
