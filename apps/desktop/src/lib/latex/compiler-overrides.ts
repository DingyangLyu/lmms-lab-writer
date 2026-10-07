/** Per-machine compiler paths that replace detection (the "本机路径覆盖" fields). */
const OVERRIDES_KEY = "writer-compiler-paths-v1";

export function readCompilerOverrides(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(OVERRIDES_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1].trim(),
      ),
    );
  } catch {
    return {};
  }
}

export function writeCompilerOverrides(overrides: Record<string, string>) {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    // Storage may be unavailable; the paths then only last for this session.
  }
}
