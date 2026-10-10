/** Conversations start at high reasoning effort wherever the model offers it. */
export const PREFERRED_EFFORT = "high";

/** `high` when the model supports it, otherwise what the caller would have picked. */
export function preferredEffort(levels: readonly string[] | undefined, otherwise: string) {
  return levels?.includes(PREFERRED_EFFORT) ? PREFERRED_EFFORT : otherwise;
}
