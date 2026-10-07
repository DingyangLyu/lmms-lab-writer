/** Error text for people; generic network failures fall back to a clearer message. */
export function getReadableErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/^(load failed|failed to fetch|networkerror)$/i.test(message.trim())) return fallback;
  return message.trim() || fallback;
}

export function getSynctexLookupMessage(error: unknown): string {
  const message = getReadableErrorMessage(error, "SyncTeX lookup failed.");
  if (message.includes("SYNCTEX_FILE_MISSING") || message.includes("No SyncTeX available"))
    return "No SyncTeX data is available for this PDF. Recompile with SyncTeX enabled.";
  return "SyncTeX lookup failed. Check that your PDF has a .synctex.gz file.";
}
