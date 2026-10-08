import { readdirSync } from "node:fs";
import { dictionaryProblems } from "@lmms-lab/i18n";
import { expect, it } from "vitest";

it("desktop dictionaries define each key once, in both languages", async () => {
  const modules: Record<string, Record<string, unknown>> = {};
  for (const name of readdirSync(__dirname))
    if (name.endsWith(".ts") && name !== "index.ts" && !name.endsWith(".test.ts"))
      modules[name] = await import(`./${name}`);
  expect(Object.keys(modules).length).toBeGreaterThan(5);
  expect(dictionaryProblems(modules)).toEqual([]);
});
