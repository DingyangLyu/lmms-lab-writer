import { defineConfig } from "vitest/config";

// Each server test starts an embedded PostgreSQL; parallel files need more than 5 s.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
