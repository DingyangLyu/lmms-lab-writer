/**
 * The lab server is opened by its plain-HTTP address, which browsers do not treat as a secure
 * context: `crypto.randomUUID` and `crypto.subtle` are missing there. Live editing once broke on
 * the lab because of it while every local test (on localhost) passed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { randomId } from "../../../packages/workbench/src/random-id";

const browserCode = [
  import.meta.dirname,
  join(import.meta.dirname, "../../../packages/workbench/src"),
  join(import.meta.dirname, "../../../packages/latex-editor/src"),
  join(import.meta.dirname, "../../../packages/writing/src"),
];
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

it("needs no secure context in the browser code the web app runs", () => {
  const offenders = browserCode
    .flatMap(sources)
    .filter((file) => !file.endsWith("random-id.ts"))
    .filter((file) => /crypto\.randomUUID\(|crypto\.subtle/.test(readFileSync(file, "utf8")));
  expect(offenders).toEqual([]);
});

it("makes version-4 UUIDs without crypto.randomUUID", () => {
  const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    const id = randomId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomId()).not.toBe(id);
  } finally {
    if (original) Object.defineProperty(crypto, "randomUUID", original);
    else delete (crypto as { randomUUID?: unknown }).randomUUID;
  }
});
