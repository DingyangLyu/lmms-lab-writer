import { resolve } from "node:path";
import "./environment";
import { createWriterServer } from "./app";

const app = await createWriterServer({
  directory: resolve(process.env.WRITER_DATA_DIR || ".data"),
  host: process.env.WRITER_HOST || "127.0.0.1",
  port: Number(process.env.WRITER_PORT || 8787),
  origin: process.env.WRITER_ORIGIN,
  adminUser: process.env.WRITER_ADMIN_USER,
  adminPassword: process.env.WRITER_ADMIN_PASSWORD,
});
console.log(`Writer collaboration ready: ${app.origin}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
