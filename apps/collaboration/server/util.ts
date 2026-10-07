/** Pure helpers shared by the server and the local runner; no database access here. */
import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";

export type Role = "owner" | "editor" | "commenter" | "viewer";
export type Access = "read" | "comment" | "edit" | "owner";
export const allows = (role: Role, minimum: Access) =>
  minimum === "read" ||
  (minimum === "comment" && role !== "viewer") ||
  (minimum === "edit" && (role === "owner" || role === "editor")) ||
  (minimum === "owner" && role === "owner");
export const roles: Role[] = ["owner", "editor", "commenter", "viewer"];

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
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
export const digest = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
export function safePath(value: string) {
  if (
    !value ||
    value.length > 240 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").some((p) => !p || p.startsWith(".")) ||
    value.includes(":") ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  )
    fail(400, "无效文件路径");
  return value;
}
/** Shared by the server and the runner so both treat the same files as editable text. */
export const textExtensions = new Set([
  "tex",
  "bib",
  "md",
  "txt",
  "sty",
  "cls",
  "bst",
  "csv",
  "json",
  "py",
  "yml",
  "yaml",
]);
export const isTextPath = (path: string) =>
  textExtensions.has(path.split(".").pop()?.toLowerCase() ?? "");
export function textDoc(value: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  return doc;
}
export function decodeText(state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}
