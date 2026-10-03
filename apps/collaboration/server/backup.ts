import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const source = process.argv[2],
  destination = process.argv[3];
if (!source || !destination)
  throw new Error("用法：pnpm backup /path/writer.sqlite /path/backup.sqlite");
const target = resolve(destination);
await stat(resolve(source));
try {
  await stat(target);
  throw new Error("备份目标已存在，拒绝覆盖");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await mkdir(dirname(target), { recursive: true });
const db = new DatabaseSync(resolve(source), { readOnly: true });
try {
  await backup(db, target);
  await chmod(target, 0o600);
  console.log(`Consistent database backup saved: ${target}`);
} finally {
  db.close();
}
