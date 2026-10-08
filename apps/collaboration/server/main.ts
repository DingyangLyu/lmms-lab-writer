import { resolve } from "node:path";
import "./environment";
import { createWriterServer } from "./app";

const configured = process.env.WRITER_DATABASE_URL;
const databaseUrl =
  configured || `pglite:${resolve(process.env.WRITER_DATA_DIR || ".data", "postgres")}`;
if (!configured)
  console.warn(
    `WRITER_DATABASE_URL 未设置，使用内嵌数据库 ${databaseUrl}。多人长期使用请连接独立 PostgreSQL。`,
  );
const sharedToken = process.env.WRITER_SHARED_RUNNER_TOKEN;
// Same form as project runner tokens, e.g. `openssl rand -hex 32`.
if (sharedToken && !/^[a-f0-9]{64}$/.test(sharedToken))
  throw new Error(
    "WRITER_SHARED_RUNNER_TOKEN 必须是 64 位十六进制字符（例如 openssl rand -hex 32）",
  );
const app = await createWriterServer({
  databaseUrl,
  host: process.env.WRITER_HOST || "127.0.0.1",
  port: Number(process.env.WRITER_PORT || 8787),
  origin: process.env.WRITER_ORIGIN,
  trustProxy: process.env.WRITER_TRUST_PROXY === "1",
  adminUser: process.env.WRITER_ADMIN_USER,
  adminPassword: process.env.WRITER_ADMIN_PASSWORD,
  sharedRunner: process.env.WRITER_SHARED_RUNNER_TOKEN
    ? {
        token: process.env.WRITER_SHARED_RUNNER_TOKEN,
        name: process.env.WRITER_SHARED_RUNNER_NAME || "Shared runner",
        capabilities: (process.env.WRITER_SHARED_RUNNER_HARNESSES || "codex,opencode")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      }
    : undefined,
  compile: {
    latexmk: process.env.WRITER_LATEXMK,
    timeoutMs: Number(process.env.WRITER_COMPILE_TIMEOUT || 120) * 1000,
    concurrency: Number(process.env.WRITER_COMPILE_CONCURRENCY || 2),
  },
});
console.log(`Writer collaboration ready: ${app.origin} (${app.store.db.kind})`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
