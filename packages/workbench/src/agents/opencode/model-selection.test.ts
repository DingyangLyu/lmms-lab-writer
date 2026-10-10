import { describe, expect, it } from "vitest";
import { findSelectedModel, selectInitialModel } from "./model-selection";
import type { Provider } from "./use-opencode";

const providers: Provider[] = [
  { id: "openai", name: "OpenAI", models: [{ id: "gpt-5.4", name: "GPT" }] },
  { id: "anthropic", name: "Kimi", models: [{ id: "k3", name: "Kimi K3" }] },
  { id: "openrouter", name: "Router", models: [{ id: "moonshotai/kimi-k3", name: "Kimi" }] },
];

describe("initial model selection", () => {
  it("honors OpenCode's Kimi default even when OpenAI is listed first", () => {
    expect(selectInitialModel(providers, "anthropic/k3")).toMatchObject({
      providerId: "anthropic",
      modelId: "k3",
    });
  });
  it("preserves a valid user choice", () => {
    expect(
      selectInitialModel(providers, "anthropic/k3", {
        providerId: "openai",
        modelId: "gpt-5.4",
      }),
    ).toMatchObject({ providerId: "openai", modelId: "gpt-5.4" });
  });
  it("falls back to the configured default when a saved model was removed", () => {
    expect(
      selectInitialModel(providers, "anthropic/k3", {
        providerId: "openai",
        modelId: "removed",
      }),
    ).toMatchObject({ providerId: "anthropic", modelId: "k3" });
  });
  it("keeps slashes in a model ID", () => {
    expect(selectInitialModel(providers, "openrouter/moonshotai/kimi-k3")).toMatchObject({
      providerId: "openrouter",
      modelId: "moonshotai/kimi-k3",
    });
  });
  it("drops unsupported saved reasoning variants", () => {
    expect(
      selectInitialModel(providers, undefined, {
        providerId: "anthropic",
        modelId: "k3",
        variant: "xhigh",
      })?.variant,
    ).toBeUndefined();
  });
  it("starts at high reasoning effort where the model offers it, and keeps a saved choice", () => {
    const withEfforts: Provider[] = [
      {
        id: "openai",
        name: "OpenAI",
        models: [{ id: "gpt", name: "GPT", variants: { low: {}, high: {}, xhigh: {} } }],
      },
    ];
    expect(selectInitialModel(withEfforts)?.variant).toBe("high");
    expect(selectInitialModel(withEfforts, "openai/gpt")?.variant).toBe("high");
    expect(
      selectInitialModel(withEfforts, undefined, {
        providerId: "openai",
        modelId: "gpt",
        variant: "low",
      })?.variant,
    ).toBe("low");
    expect(selectInitialModel(providers, "anthropic/k3")?.variant).toBeUndefined();
  });
  it("handles a stale default or an empty provider list", () => {
    expect(selectInitialModel(providers, "missing/model")).toMatchObject({ providerId: "openai" });
    expect(selectInitialModel([], "anthropic/k3")).toBeNull();
  });
});

it("resolves model labels and reasoning variants within the selected provider", () => {
  const providers = [
    {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "gpt-6-astra", name: "Old account", variants: { fast: {} } }],
    },
    {
      id: "codex-local",
      name: "Codex local",
      models: [{ id: "gpt-6-astra", name: "Local Codex", variants: { high: {} } }],
    },
  ];
  const selected = findSelectedModel(providers, {
    providerId: "codex-local",
    modelId: "gpt-6-astra",
  });
  expect(selected?.provider.id).toBe("codex-local");
  expect(selected?.model.name).toBe("Local Codex");
  expect(selected?.model.variants).toEqual({ high: {} });
  expect(
    findSelectedModel(providers, { providerId: "missing", modelId: "gpt-6-astra" }),
  ).toBeNull();
});
