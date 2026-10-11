import { defineConfig } from "vitest/config";

// Each server test starts an embedded PostgreSQL. Bound parallel files so multiple WASM
// databases do not exhaust memory and turn passing integration tests into timeout failures.
export default defineConfig({
  test: { maxWorkers: 2, testTimeout: 30_000, hookTimeout: 30_000 },
});
