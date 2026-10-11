import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Sql, sql } from "./db";
import { Store } from "./store";
import { fixture } from "./test-fixture";
import { decodeText } from "./util";

/** Make a concurrent commit land immediately after the first SELECT's snapshot. */
function afterFirstRead(db: Sql, change: () => Promise<unknown>): Sql {
  let changed = false;
  const after = async <T>(result: T) => {
    if (!changed) {
      changed = true;
      await change();
    }
    return result;
  };
  return {
    ...db,
    row: async <T>(query: Parameters<Sql["row"]>[0]) => after(await db.row<T>(query)),
    rows: async <T>(query: Parameters<Sql["rows"]>[0]) => after(await db.rows<T>(query)),
  };
}

describe("consistent document reads", () => {
  it("starts an embedded database when the data directory has not been created yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writer-new-data-"));
    let store: Store | undefined;
    try {
      store = await Store.open(`pglite:${join(dir, "new", "data", "postgres")}`);
      expect(await store.db.row(sql`SELECT count(*) AS count FROM users`)).toEqual({ count: 0 });
    } finally {
      await store?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    "state",
    "file",
    "project",
  ] as const)("%s reads retain acknowledged edits when compaction commits during the read", async (kind) => {
    const f = await fixture();
    const id = (
      await f.call(`/projects/${f.project}/files`, { path: "main.tex", content: "base" }, f.owner)
    ).data.id as string;
    const editor = await f.peer(f.owner, id);
    editor.send(
      "edit",
      editor.capture(() => editor.doc.getText("content").insert(4, " saved")),
    );
    await editor.next("ack");
    const store = f.app.store;
    const q = afterFirstRead(store.db, () => store.compact(id));
    const state =
      kind === "state"
        ? await store.fileState(id, q)
        : kind === "file"
          ? (await store.file(f.project, id, q)).state
          : (await store.projectFiles(f.project, q)).find((file) => file.id === id)?.state;
    expect(state).toBeDefined();
    expect(decodeText(state as Uint8Array)).toBe("base saved");
  });

  it("reads a binary file's revision and bytes from the same snapshot", async () => {
    const f = await fixture();
    const id = (
      await f.call(`/projects/${f.project}/files`, { path: "figure.png", base64: "AQ==" }, f.owner)
    ).data.id as string;
    const store = f.app.store;
    const q = afterFirstRead(store.db, () =>
      store.db.run(sql`UPDATE files SET state=${Buffer.from([2])}, revision=2 WHERE id=${id}`),
    );
    const file = await store.file(f.project, id, q);
    expect([...file.state]).toEqual([file.revision]);
  });
});
