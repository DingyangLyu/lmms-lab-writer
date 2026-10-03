#!/usr/bin/env node

const SERVER_NAME = "perplexity-search";
const SERVER_VERSION = "0.1.0";
const API_URL = "https://api.perplexity.ai/search";

let inputBuffer = Buffer.alloc(0);
let framingMode = "header";

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (framingMode === "line") {
    process.stdout.write(`${body.toString("utf8")}\n`);
    return;
  }

  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function parseMessages() {
  while (true) {
    const headerPrefix = inputBuffer.slice(0, 64).toString("utf8").toLowerCase();
    if (!headerPrefix.startsWith("content-length:")) {
      const lineEnd = inputBuffer.indexOf("\n");
      if (lineEnd === -1) return;

      const rawLine = inputBuffer.slice(0, lineEnd).toString("utf8").trim();
      inputBuffer = inputBuffer.slice(lineEnd + 1);
      if (!rawLine) continue;

      framingMode = "line";
      try {
        void handleMessage(JSON.parse(rawLine));
      } catch (error) {
        sendError(null, -32700, error instanceof Error ? error.message : "Parse error");
      }
      continue;
    }

    let separatorLength = 4;
    let headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      headerEnd = inputBuffer.indexOf("\n\n");
      separatorLength = 2;
    }
    if (headerEnd === -1) return;

    const header = inputBuffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/content-length:\s*(\d+)/i);
    if (!match) {
      inputBuffer = inputBuffer.slice(headerEnd + 4);
      continue;
    }

    const length = Number(match[1]);
    const bodyStart = headerEnd + separatorLength;
    const bodyEnd = bodyStart + length;
    if (inputBuffer.length < bodyEnd) return;

    const raw = inputBuffer.slice(bodyStart, bodyEnd).toString("utf8");
    inputBuffer = inputBuffer.slice(bodyEnd);

    framingMode = "header";
    try {
      void handleMessage(JSON.parse(raw));
    } catch (error) {
      sendError(null, -32700, error instanceof Error ? error.message : "Parse error");
    }
  }
}

function asPositiveInt(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function asOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  return items.length > 0 ? items : undefined;
}

function normalizeSearchResult(result, index) {
  const title = typeof result?.title === "string" ? result.title : `Result ${index + 1}`;
  const url = typeof result?.url === "string" ? result.url : "";
  const snippet = typeof result?.snippet === "string" ? result.snippet : "";
  const date = typeof result?.date === "string" && result.date ? `\nPublished: ${result.date}` : "";
  const updated =
    typeof result?.last_updated === "string" && result.last_updated
      ? `\nLast updated: ${result.last_updated}`
      : "";

  return [
    `### ${index + 1}. ${title}`,
    url ? `URL: ${url}` : undefined,
    snippet ? `Snippet: ${snippet}` : undefined,
    date.trim() ? date.trim() : undefined,
    updated.trim() ? updated.trim() : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

async function callPerplexitySearch(args) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "PERPLEXITY_API_KEY is not set. Create a Perplexity API key and start Writer/OpenCode with that environment variable.",
    );
  }

  const query = asOptionalString(args.query);
  if (!query) {
    throw new Error("query is required");
  }

  const body = {
    query,
    max_results: asPositiveInt(args.maxResults ?? args.max_results, 8, 1, 20),
    search_context_size: asOptionalString(args.searchContextSize ?? args.search_context_size) ?? "medium",
    country: asOptionalString(args.country),
    search_domain_filter: asStringArray(args.searchDomainFilter ?? args.search_domain_filter),
    search_language_filter: asStringArray(args.searchLanguageFilter ?? args.search_language_filter),
    search_recency_filter: asOptionalString(args.recency ?? args.search_recency_filter),
  };

  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Perplexity Search API returned ${response.status}: ${
        typeof data?.error?.message === "string" ? data.error.message : text.slice(0, 500)
      }`,
    );
  }

  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    return `No Perplexity search results for: ${query}`;
  }

  return [
    `Perplexity Search results for: ${query}`,
    `Request id: ${typeof data.id === "string" ? data.id : "unknown"}`,
    "",
    ...results.map(normalizeSearchResult),
  ].join("\n\n");
}

const tools = [
  {
    name: "perplexity_search",
    description:
      "Search the live web with Perplexity Search API and return ranked results with URLs, snippets, dates, and update timestamps. Use this for current information and as a fallback when OpenCode websearch/Exa is rate limited.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query.",
        },
        maxResults: {
          type: "number",
          minimum: 1,
          maximum: 20,
          description: "Number of results to return. Defaults to 8.",
        },
        searchContextSize: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "How much extracted page context to return. Defaults to medium.",
        },
        country: {
          type: "string",
          description: "Optional ISO 3166-1 alpha-2 country code, such as US.",
        },
        searchDomainFilter: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional domain allowlist/denylist. Prefix domains with '-' to exclude, for example ['-reddit.com'].",
        },
        searchLanguageFilter: {
          type: "array",
          items: { type: "string" },
          description: "Optional ISO 639-1 language codes, such as ['en', 'zh'].",
        },
        recency: {
          type: "string",
          enum: ["hour", "day", "week", "month", "year"],
          description: "Optional publication recency filter.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

async function handleMessage(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      if (name !== "perplexity_search") {
        throw new Error(`Unknown tool: ${name}`);
      }
      const text = await callPerplexitySearch(args);
      sendResult(id, {
        content: [{ type: "text", text }],
      });
    } catch (error) {
      sendResult(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : "Perplexity search failed",
          },
        ],
      });
    }
    return;
  }

  if (id !== undefined && id !== null) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  parseMessages();
});

process.stdin.resume();
