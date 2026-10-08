import { i18n } from "@/lib/i18n";
import {
  extractTextParts,
  type OpenCodeMessageItem,
  parseOpenCodeMessageResponse,
} from "@/lib/opencode/messages";
import { getPreferredOpenCodeConfig } from "@/lib/opencode/preferences";
import { sleep } from "@/lib/timing";

function messageItems(data: unknown): OpenCodeMessageItem[] {
  if (Array.isArray(data)) return data as OpenCodeMessageItem[];
  const messages = (data as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? (messages as OpenCodeMessageItem[]) : [];
}

/**
 * Sends one prompt to a throwaway OpenCode session and returns the assistant's text reply.
 * The session is deleted afterwards, so nothing shows up in the user's conversation list.
 */
export async function runOpenCodePrompt({
  port,
  directory,
  prompt,
  timeoutMs,
}: {
  port: number;
  directory: string;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  const baseUrl = `http://localhost:${port}`;
  const query = `?directory=${encodeURIComponent(directory)}`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-opencode-directory": encodeURIComponent(directory),
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let sessionId: string | null = null;
  const request = async (path: string, init: RequestInit, failure: string) => {
    const response = await fetch(`${baseUrl}${path}${query}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`${failure}: ${response.status} ${errorText}`);
    }
    return (await response.json()) as unknown;
  };

  try {
    const session = (await request(
      "/session",
      { method: "POST", body: JSON.stringify({}) },
      i18n.t("msg.couldNotCreateAnOpencodeSession"),
    )) as { id?: string };
    if (!session.id) throw new Error(i18n.t("msg.theOpencodeSessionResponseHasNoId"));
    sessionId = session.id;

    const preferred = getPreferredOpenCodeConfig();
    const reply = parseOpenCodeMessageResponse(
      await request(
        `/session/${sessionId}/message`,
        {
          method: "POST",
          body: JSON.stringify({
            parts: [{ type: "text", text: prompt }],
            noReply: false,
            ...preferred,
          }),
        },
        i18n.t("msg.theOpencodeMessageFailed"),
      ),
    );
    const initialText = extractTextParts(reply?.parts).join("\n").trim();
    if (initialText) return initialText;

    const parentMessageId = reply?.info?.role === "user" ? reply.info.id : undefined;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const items = messageItems(
        await request(
          `/session/${sessionId}/message`,
          { method: "GET" },
          i18n.t("msg.couldNotPollOpencodeMessages"),
        ),
      );
      for (let i = items.length - 1; i >= 0; i--) {
        const info = items[i]?.info;
        if (info?.role !== "assistant") continue;
        if (parentMessageId && info.parentID && info.parentID !== parentMessageId) continue;
        const text = extractTextParts(items[i]?.parts).join("\n").trim();
        if (text) return text;
        const errorMessage = info.error?.data?.message;
        if (errorMessage) throw new Error(errorMessage);
      }
      await sleep(500);
    }
    throw new Error(i18n.t("msg.opencodeReturnedAnEmptyResponse"));
  } finally {
    clearTimeout(timeoutId);
    if (sessionId)
      void fetch(`${baseUrl}/session/${sessionId}${query}`, { method: "DELETE", headers }).catch(
        () => {},
      );
  }
}
