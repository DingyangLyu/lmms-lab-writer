/** Pure helpers shared by the server and the local runner; no database access here. */
import { createHash, randomUUID } from "node:crypto";
import { format, type Params } from "@lmms-lab/i18n";
import { isTextPath, textExtensions, validPath } from "@lmms-lab/sync";
import * as Y from "yjs";

export type Role = "owner" | "editor" | "commenter" | "viewer";
export type Access = "read" | "comment" | "edit" | "owner";
export const allows = (role: Role, minimum: Access) =>
  minimum === "read" ||
  (minimum === "comment" && role !== "viewer") ||
  (minimum === "edit" && (role === "owner" || role === "editor")) ||
  (minimum === "owner" && role === "owner");
export const roles: Role[] = ["owner", "editor", "commenter", "viewer"];

/** `message` is Chinese; `template` and `params` let a client get it in English (messages.ts). */
export class HttpError extends Error {
  constructor(
    public status: number,
    readonly template: string,
    readonly params?: Params,
  ) {
    super(format(template, params));
  }
}
/**
 * Signed out, not a member, or gone — as opposed to a passing failure such as the database
 * restarting, after which a connection should simply try again.
 */
export const accessDenied = (error: unknown) =>
  error instanceof HttpError && [401, 403, 404].includes(error.status);
/** Close code for a passing failure: the page reconnects instead of treating it as lost access. */
export const RETRY_CLOSE = 1011;
/**
 * The database or the network failing for a moment (PostgreSQL restarting, a dropped
 * connection), as opposed to a bad request: worth trying again rather than refusing.
 */
export function transientFailure(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code ?? "");
  const message = error instanceof Error ? error.message : "";
  return (
    // SQLSTATE classes 08 (connection), 53 (resources), 57 (operator intervention, e.g. shutdown)
    /^(08|53|57)[0-9A-Z]{3}$/.test(code) ||
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTCONN"].includes(code) ||
    /Connection terminated|connection (?:is )?closed|timeout exceeded/i.test(message)
  );
}
export function fail(status: number, template: string, params?: Params): never {
  throw new HttpError(status, template, params);
}
/** Parser and validation errors from shared writing helpers are user input errors, not 500s. */
export function checked<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, error instanceof Error ? error.message : "输入无效");
  }
}
export const uid = () => randomUUID();
/** A filesystem path with forward slashes and an upper-case drive letter, as TeX may write it. */
export const slashes = (path: string) =>
  path.replace(/\\/g, "/").replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
export const digest = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
export function safePath(value: string) {
  if (!validPath(value)) fail(400, "无效文件路径");
  return value;
}
/** The same rules as the desktop folder sync, so both treat the same files as editable text. */
export { isTextPath, textExtensions };
/**
 * Shared text keeps "\n" line endings only. CodeMirror counts "\r\n" as one character and
 * Yjs as two, so a "\r" (a Windows checkout or upload) shifts every position after it: edits,
 * comments and AI changes land in the wrong place.
 */
export const normalizeEol = (text: string) => text.replace(/\r\n?/g, "\n");
export function textDoc(value: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, normalizeEol(value));
  return doc;
}
export function decodeText(state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}
