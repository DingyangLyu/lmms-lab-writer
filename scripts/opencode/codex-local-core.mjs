import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER = "codex-local";
export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

export async function readCodexAuth(home = codexHome()) {
  const data = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
  const tokens = data.tokens;
  if (data.auth_mode !== "chatgpt" || !tokens?.access_token || !tokens?.account_id) {
    throw new Error("请先在本机 Codex 中使用 ChatGPT 账号登录，再重试。");
  }
  let expiry = 0;
  try {
    expiry =
      JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()).exp * 1000;
  } catch {
    /* Opaque tokens are validated by the service. */
  }
  if (expiry && expiry <= Date.now()) {
    throw new Error(
      "本机 Codex 登录凭据已过期。请在 Codex 中完成一次登录或请求，刷新 auth.json 后重试。",
    );
  }
  return { access: tokens.access_token, accountId: tokens.account_id };
}

export function buildModels(cache) {
  return Object.fromEntries(
    (cache.models || [])
      .filter((model) => model.visibility === "list")
      .map((model) => [
        model.slug,
        {
          id: model.slug,
          name: `${model.display_name || model.slug} (Codex)`,
          reasoning: true,
          tool_call: true,
          attachment: (model.input_modalities || []).includes("image"),
          modalities: {
            input: (model.input_modalities || ["text"]).filter((kind) =>
              ["text", "image"].includes(kind),
            ),
            output: ["text"],
          },
          limit: { context: model.context_window || 272000, output: 32768 },
          options: {
            store: false,
            reasoningEffort: model.default_reasoning_level || "medium",
            include: ["reasoning.encrypted_content"],
          },
          variants: Object.fromEntries(
            (model.supported_reasoning_levels || [])
              .filter(({ effort }) => ["low", "medium", "high", "xhigh"].includes(effort))
              .map(({ effort }) => [effort, { reasoningEffort: effort }]),
          ),
        },
      ]),
  );
}

/** Read current Codex credentials on every request; never copy or rotate its refresh token. */
export function codexFetch({ getAuth = readCodexAuth, request = globalThis.fetch } = {}) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== "https://chatgpt.com" || url.pathname !== "/backend-api/codex/responses") {
      throw new Error(
        "Codex credentials may only be sent to the official Codex responses endpoint.",
      );
    }
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    if (!body.model) throw new Error("Missing Codex model");
    body.store = false;
    body.stream = true;
    body.instructions ??= "You are a helpful writing and coding assistant.";
    delete body.max_output_tokens;
    delete body.temperature;
    delete body.top_p;
    const auth = await getAuth();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${auth.access}`);
    headers.set("ChatGPT-Account-Id", auth.accountId);
    headers.set("originator", "opencode");
    return request(url, { ...init, headers, body: JSON.stringify(body), redirect: "error" });
  };
}
