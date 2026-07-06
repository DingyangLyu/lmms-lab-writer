const SEARCH_FALLBACK_TAG = "lmms-lab-writer-search-fallback";
const SEARCH_FALLBACK_HINT = [
  `<${SEARCH_FALLBACK_TAG}>`,
  "Respect explicit user tool requests. Otherwise, when live web search is needed, try OpenCode websearch normally. If websearch returns a 429, non-2xx status, Exa MCP rate limit, or transport error, retry the same query with perplexity_search when available, then use webfetch for exact URLs.",
  `</${SEARCH_FALLBACK_TAG}>`,
].join("\n");

const SEARCH_FALLBACK_HINT_PATTERN =
  /\n{0,2}<lmms-lab-writer-search-fallback>[\s\S]*?<\/lmms-lab-writer-search-fallback>/g;

export function appendSearchFallbackHint(content: string): string {
  if (!content.trim() || content.includes(`<${SEARCH_FALLBACK_TAG}>`)) {
    return content;
  }

  return `${content.trimEnd()}\n\n${SEARCH_FALLBACK_HINT}`;
}

export function stripSearchFallbackHint(content: string): string {
  return content.replace(SEARCH_FALLBACK_HINT_PATTERN, "").trimEnd();
}
