/** The agent and model chosen in the OpenCode panel, shared with one-shot prompts. */
export const STORAGE_KEY_AGENT = "opencode-selected-agent";
export const STORAGE_KEY_MODEL = "opencode-selected-model";

export type PreferredOpenCodeConfig = {
  agent?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
};

export function getPreferredOpenCodeConfig(): PreferredOpenCodeConfig {
  if (typeof window === "undefined") return {};
  try {
    const agent = localStorage.getItem(STORAGE_KEY_AGENT) || undefined;
    const raw = localStorage.getItem(STORAGE_KEY_MODEL);
    if (!raw) return { agent };
    const saved = JSON.parse(raw) as { providerId?: unknown; modelId?: unknown; variant?: unknown };
    if (typeof saved.providerId !== "string" || typeof saved.modelId !== "string") return { agent };
    const model = { providerID: saved.providerId, modelID: saved.modelId };
    return typeof saved.variant === "string" && saved.variant.length > 0
      ? { agent, model, variant: saved.variant }
      : { agent, model };
  } catch {
    return {};
  }
}
