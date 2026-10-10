import { describe, expect, it } from "vitest";
import { fixture } from "./test-fixture";
import { HttpError, transientFailure } from "./util";

describe("passing failures", () => {
  it("tells a database or network hiccup from a bad request", () => {
    expect(
      transientFailure(Object.assign(new Error("terminating connection"), { code: "57P01" })),
    ).toBe(true);
    expect(transientFailure(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(
      true,
    );
    expect(transientFailure(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(transientFailure(new Error("Unexpected end of array"))).toBe(false);
    expect(transientFailure(new HttpError(413, "文本文件超过 2 MB"))).toBe(false);
    expect(transientFailure(Object.assign(new Error("dup"), { code: "23505" }))).toBe(false);
  });

  it("keeps editors connected when the access check fails for a moment, and closes them when access is gone", async () => {
    const f = await fixture();
    const file = (
      await f.call(`/projects/${f.project}/files`, { path: "main.tex", content: "Hi\n" }, f.owner)
    ).data.id;
    const editor = await f.peer(f.owner, file);
    const store = f.app.store;
    const require = store.require.bind(store);
    const closed = new Promise<number>((resolve) => editor.ws.on("close", (code) => resolve(code)));

    // The database restarts while the periodic check runs.
    store.require = async () => {
      throw new Error("Connection terminated unexpectedly");
    };
    await f.app.collab.recheck();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(editor.ws.readyState).toBe(editor.ws.OPEN);

    // The member really lost access: the page is told so.
    store.require = async () => {
      throw new HttpError(403, "当前角色不允许此操作");
    };
    await f.app.collab.recheck();
    expect(await closed).toBe(1008);
    store.require = require;
  });
});
