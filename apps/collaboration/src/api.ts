import { i18n } from "./i18n";
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  // The server words its errors in the interface language.
  const headers: Record<string, string> = { "X-Writer-Locale": i18n.getLocale() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || i18n.t("common.requestFailed", { status: response.status }));
  return data as T;
}
/** What a user should read: the message, without the "Error:" prefix of String(error). */
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
export const unbase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export function download(name: string, data: Blob) {
  const url = URL.createObjectURL(data),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
