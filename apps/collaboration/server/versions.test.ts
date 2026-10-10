import { describe, expect, it } from "vitest";
import type { Snapshot } from "../shared/api";
import { fixture } from "./test-fixture";

describe("automatic versions", () => {
  it("saves a version of an edited project at most every half hour, and none without edits", async () => {
    const f = await fixture();
    const file = (
      await f.call(`/projects/${f.project}/files`, { path: "main.tex", content: "One\n" }, f.owner)
    ).data.id;
    const editor = await f.peer(f.owner, file);
    const type = async (text: string) => {
      editor.send(
        `edit-${text}`,
        editor.capture(() => editor.doc.getText("content").insert(0, text)),
      );
      await editor.next("ack");
    };
    const versions = async () =>
      (
        (await f.call(`/projects/${f.project}/snapshots`, undefined, f.owner)).data as Snapshot[]
      ).filter((s) => s.label === "自动保存版本");
    const now = Date.now();

    await f.app.collab.autosave(now);
    expect(await versions()).toEqual([]);

    await type("Two ");
    await f.app.collab.autosave(now);
    expect(await versions()).toHaveLength(1);
    // Nothing changed since.
    await f.app.collab.autosave(now + 60 * 60_000);
    expect(await versions()).toHaveLength(1);

    // Edited again: not within half an hour of the last version, but after it.
    await type("Three ");
    await f.app.collab.autosave(now + 10 * 60_000);
    expect(await versions()).toHaveLength(1);
    await f.app.collab.autosave(Date.now() + 31 * 60_000);
    expect(await versions()).toHaveLength(2);
  });
});
