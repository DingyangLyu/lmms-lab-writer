import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const env = process.env.WRITER_ENV_FILE || resolve(import.meta.dirname, "../.env");
if (existsSync(env)) loadEnvFile(env);
