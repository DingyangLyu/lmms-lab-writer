import { PREFERRED_EFFORT } from "../chat/effort";
import type { Model, Provider, SelectedModel } from "./use-opencode";

export function findSelectedModel(providers: Provider[], selection: SelectedModel | null) {
  if (!selection) return null;
  const provider = providers.find((provider) => provider.id === selection.providerId);
  const model = provider?.models.find((model) => model.id === selection.modelId);
  return provider && model ? { provider, model } : null;
}

export function isVariantSupported(model: Model | undefined, variant: string | undefined): boolean {
  if (!model || !variant) return false;
  const config = model.variants?.[variant];
  return Boolean(config && config.disabled !== true);
}

/** High reasoning effort when the model offers it; otherwise OpenCode's own default. */
export function preferredVariant(model: Model | undefined): string | undefined {
  return isVariantSupported(model, PREFERRED_EFFORT) ? PREFERRED_EFFORT : undefined;
}

/** Preserve an explicit choice, then honor the daemon's configured default. */
export function selectInitialModel(
  providers: Provider[],
  configuredModel?: string,
  savedModel?: SelectedModel | null,
): SelectedModel | null {
  const validate = (selection: SelectedModel | null | undefined): SelectedModel | null => {
    if (!selection) return null;
    const model = providers
      .find((provider) => provider.id === selection.providerId)
      ?.models.find((model) => model.id === selection.modelId);
    if (!model) return null;
    return {
      providerId: selection.providerId,
      modelId: selection.modelId,
      variant: isVariantSupported(model, selection.variant)
        ? selection.variant
        : preferredVariant(model),
    };
  };

  const saved = validate(savedModel);
  if (saved) return saved;

  const separator = configuredModel?.indexOf("/") ?? -1;
  if (configuredModel && separator > 0) {
    const configured = validate({
      providerId: configuredModel.slice(0, separator),
      modelId: configuredModel.slice(separator + 1),
    });
    if (configured) return configured;
  }

  const provider = providers.find((provider) => provider.models.length > 0);
  const model = provider?.models[0];
  return provider && model
    ? { providerId: provider.id, modelId: model.id, variant: preferredVariant(model) }
    : null;
}
