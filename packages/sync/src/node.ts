/** Node adapters for FolderSync: a directory, fetch + ws with a device token, a JSON file. */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { type LocalFolder, RequestError, type StateStore, type Transport } from "./types";

const same = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null || b === null ? a === b : Buffer.compare(a, b) === 0;

/** Hidden entries (".git", ".writer") are never listed. */
export function nodeFolder(root: string): LocalFolder {
  const absolute = (path: string) => join(root, ...path.split("/"));
  const read = async (path: string) => {
    try {
      return new Uint8Array(await readFile(absolute(path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const list = async (dir = ""): Promise<string[]> => {
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...(await list(path)));
      else if (entry.isFile()) files.push(path);
    }
    return files;
  };
  return {
    list: () => list(),
    read,
    async write(path, data, expected) {
      if (!same(await read(path), expected)) return false;
      await mkdir(dirname(absolute(path)), { recursive: true });
      await writeFile(absolute(path), data);
      return true;
    },
    async remove(path, expected) {
      if (!same(await read(path), expected)) return false;
      await rm(absolute(path));
      return true;
    },
    async move(from, to) {
      if ((await read(to)) !== null || (await read(from)) === null) return false;
      await mkdir(dirname(absolute(to)), { recursive: true });
      await rename(absolute(from), absolute(to));
      return true;
    },
  };
}

export function nodeTransport(origin: string, token: string): Transport {
  const auth = { Authorization: `Bearer ${token}` };
  return {
    async request<T>(method: string, path: string, body?: unknown) {
      const response = await fetch(origin + path, {
        method,
        headers: body === undefined ? auth : { ...auth, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new RequestError(response.status, data.error ?? response.statusText);
      return data as T;
    },
    connect(path, events) {
      const ws = new WebSocket(origin.replace(/^http/, "ws") + path, { headers: auth });
      const waiting: string[] = [];
      ws.on("open", () => {
        for (const data of waiting.splice(0)) ws.send(data);
      });
      ws.on("message", (data) => events.message(data.toString()));
      ws.on("close", (code, reason) => events.close(code, reason.toString()));
      ws.on("error", () => {});
      return {
        send: (data) => (ws.readyState === WebSocket.OPEN ? ws.send(data) : waiting.push(data)),
        close: () => ws.close(),
      };
    },
  };
}

export function jsonFileStore(file: string): StateStore {
  return {
    load: () => readFile(file, "utf8").catch(() => null),
    async save(data) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data);
    },
  };
}
