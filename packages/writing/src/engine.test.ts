import { describe, expect, it } from "vitest";
// Also run by the desktop's Rust (latex_build.rs), which must choose the same engines.
import CASES from "../fixtures/engine-cases.json" with { type: "json" };
import { texEngine } from "./engine";

describe("the engine a project needs, as the desktop decides it", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const files: Record<string, string | undefined> = c.files;
    expect(texEngine((path) => files[path], c.main, c.base)).toBe(c.engine);
  });
});
