/** Minimal shapes of OpenCode message responses used by one-shot prompts. */
export type OpenCodeMessagePart = { type?: string; text?: string };
export type OpenCodeMessageInfo = {
  id?: string;
  role?: string;
  parentID?: string;
  error?: { data?: { message?: string } };
};
export type OpenCodeMessageItem = { info?: OpenCodeMessageInfo; parts?: OpenCodeMessagePart[] };

export function extractTextParts(parts: OpenCodeMessagePart[] | undefined): string[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
}

export function parseOpenCodeMessageResponse(data: unknown): OpenCodeMessageItem | null {
  if (!data || typeof data !== "object") return null;
  return data as OpenCodeMessageItem;
}
