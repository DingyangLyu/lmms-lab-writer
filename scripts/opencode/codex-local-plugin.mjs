import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildModels, CODEX_BASE, codexFetch, codexHome, PROVIDER } from "./codex-local-core.mjs";

export default async function CodexLocalPlugin() {
  return {
    async config(config) {
      let cache;
      try {
        cache = JSON.parse(await readFile(join(codexHome(), "models_cache.json"), "utf8"));
      } catch {
        // Missing Codex setup must not prevent Kimi or other providers from starting.
        return;
      }
      config.provider ??= {};
      config.provider[PROVIDER] = {
        name: "Codex（本机登录）",
        npm: "@ai-sdk/openai",
        options: { baseURL: CODEX_BASE, apiKey: "local-codex-auth", store: false },
        models: buildModels(cache),
      };
    },
    auth: {
      provider: PROVIDER,
      methods: [],
      async loader() {
        return { apiKey: "local-codex-auth", fetch: codexFetch() };
      },
    },
  };
}
