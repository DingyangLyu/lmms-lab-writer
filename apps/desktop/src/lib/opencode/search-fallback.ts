import type { Part, ToolPart } from "./types";

const SEARCH_FALLBACK_TAG = "lmms-lab-writer-search-fallback";
const AUTO_WEBSEARCH_FALLBACK_TEXT = "Retrying failed websearch with Perplexity.";
const SEARCH_FALLBACK_HINT = [
  `<${SEARCH_FALLBACK_TAG}>`,
  "Respect explicit user tool requests. Otherwise, when live web search is needed, try OpenCode websearch normally. If websearch returns a 429, non-2xx status, Exa MCP rate limit, or transport error, retry the same query with perplexity_search when available, then use webfetch for exact URLs.",
  `</${SEARCH_FALLBACK_TAG}>`,
].join("\n");

const SEARCH_FALLBACK_HINT_PATTERN =
  /\n{0,2}<lmms-lab-writer-search-fallback>[\s\S]*?<\/lmms-lab-writer-search-fallback>/g;

export type WebsearchFallbackFailure = {
  partId: string;
  query: string;
  error: string;
};

export function appendSearchFallbackHint(content: string): string {
  if (!content.trim() || content.includes(`<${SEARCH_FALLBACK_TAG}>`)) {
    return content;
  }

  return `${content.trimEnd()}\n\n${SEARCH_FALLBACK_HINT}`;
}

export function stripSearchFallbackHint(content: string): string {
  return content.replace(SEARCH_FALLBACK_HINT_PATTERN, "").trimEnd();
}

export function isPerplexitySearchPart(part: Part): boolean {
  return isToolPart(part) && part.tool.toLowerCase().includes("perplexity_search");
}

export function getWebsearchFallbackFailure(part: Part): WebsearchFallbackFailure | null {
  if (!isToolPart(part) || part.tool.toLowerCase() !== "websearch") {
    return null;
  }

  if (part.state.status !== "error") {
    return null;
  }

  return {
    partId: part.id,
    query: getSearchQuery(part.state.input),
    error: String(part.state.error || "websearch failed"),
  };
}

export function buildWebsearchFallbackPrompt(failures: WebsearchFallbackFailure[]): string {
  const queries = Array.from(
    new Set(failures.map((failure) => failure.query).filter((query) => query !== "(unknown)")),
  );
  const errorSummary = failures
    .map((failure) => `- ${failure.query}: ${truncate(failure.error, 500)}`)
    .join("\n");
  const queryBlock =
    queries.length > 0
      ? queries.map((query, index) => `${index + 1}. ${query}`).join("\n")
      : "(the previous websearch query)";

  return [
    AUTO_WEBSEARCH_FALLBACK_TEXT,
    "",
    `<${SEARCH_FALLBACK_TAG}>`,
    "Continue the previous request. The built-in OpenCode websearch call failed, so this is the fallback retry. Use perplexity_search for the failed query or queries below. Use webfetch only for exact URLs returned by search results, then continue the original task.",
    "",
    "Failed query or queries:",
    queryBlock,
    "",
    "Websearch error summary:",
    errorSummary || "- websearch failed",
    `</${SEARCH_FALLBACK_TAG}>`,
  ].join("\n");
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool" && "tool" in part && "state" in part;
}

function getSearchQuery(input: Record<string, unknown>): string {
  for (const key of ["query", "q", "search", "keywords"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  try {
    const serialized = JSON.stringify(input);
    return serialized ? truncate(serialized, 200) : "(unknown)";
  } catch {
    return "(unknown)";
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
