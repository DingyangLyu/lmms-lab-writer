import { describe, expect, it, vi } from "vitest";
import { ProjectTransition, prepareProject } from "./project-transition";
import { type Draft, SaveManager } from "./save-manager";

function setup(write: (draft: Draft) => Promise<void>) {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const manager = new SaveManager(write, storage, 100_000);
  manager.open("/old", "main.tex", "original");
  manager.edit("/old", "main.tex", "unsaved paragraph");
  const actions = {
    current: "/old",
    choose: async () => "/new",
    confirm: async () => true,
    freeze: vi.fn(),
    save: () => manager.flushAll(),
    open: vi.fn(async (_path: string) => {}),
    reset: vi.fn(),
  };
  return { manager, data, actions };
}

describe("project switch preserves current work", () => {
  it("waits for in-flight writes and a later edit before changing roots", async () => {
    let finish = () => {};
    const writes: Draft[] = [];
    const { manager, actions } = setup(async (draft) => {
      writes.push(draft);
      if (writes.length === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    });
    const gate = new ProjectTransition();
    const result = gate.run(actions);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    manager.edit("/old", "main.tex", "last composition committed");
    expect(actions.open).not.toHaveBeenCalled();
    finish();
    expect(await result).toBe("/new");
    expect(writes.map((draft) => [draft.project, draft.content])).toEqual([
      ["/old", "unsaved paragraph"],
      ["/old", "last composition committed"],
    ]);
    expect(actions.reset).toHaveBeenCalledOnce();
    expect(manager.get("/old", "main.tex")?.dirty).toBe(false);
  });

  it("keeps buffers and recovery data when saving fails", async () => {
    const { manager, data, actions } = setup(async () => {
      throw new Error("disk full");
    });
    const gate = new ProjectTransition();
    await expect(gate.run(actions)).rejects.toThrow("disk full");
    expect(actions.open).not.toHaveBeenCalled();
    expect(actions.reset).not.toHaveBeenCalled();
    expect(manager.get("/old", "main.tex")).toMatchObject({
      dirty: true,
      content: "unsaved paragraph",
    });
    expect([...data.values()][0]).toContain("unsaved paragraph");
    expect(actions.freeze).toHaveBeenLastCalledWith(false);
    expect(gate.active).toBe(false);
  });

  it("does not activate an unreadable destination or clear the old tabs", async () => {
    const { manager, actions } = setup(async () => {});
    const activate = vi.fn(async () => {});
    actions.open = vi.fn((path: string) =>
      prepareProject(
        path,
        async () => {
          throw new Error("folder inaccessible");
        },
        activate,
      ),
    );
    await expect(new ProjectTransition().run(actions)).rejects.toThrow("folder inaccessible");
    expect(activate).not.toHaveBeenCalled();
    expect(actions.reset).not.toHaveBeenCalled();
    expect(manager.get("/old", "main.tex")?.content).toBe("unsaved paragraph");
    expect(manager.get("/old", "main.tex")?.dirty).toBe(false);
  });

  it("leaves state alone on cancel, same folder, or declined background-task confirmation", async () => {
    for (const [path, allowed] of [
      [null, true],
      ["/old", true],
      ["/new", false],
    ] as const) {
      const save = vi.fn(async () => {}),
        reset = vi.fn(),
        open = vi.fn(async () => {});
      expect(
        await new ProjectTransition().run({
          current: "/old",
          choose: async () => path,
          confirm: async () => allowed,
          freeze: vi.fn(),
          save,
          reset,
          open,
        }),
      ).toBeNull();
      expect(save).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
    }
  });

  it("rejects concurrent pickers and keeps the first target", async () => {
    let selected: (path: string) => void = () => {};
    const gate = new ProjectTransition();
    const open = vi.fn(async () => {});
    const actions = {
      current: "/old",
      choose: () =>
        new Promise<string>((resolve) => {
          selected = resolve;
        }),
      confirm: async () => true,
      freeze: vi.fn(),
      save: async () => {},
      reset: vi.fn(),
      open,
    };
    const first = gate.run(actions);
    const second = vi.fn(async () => "/other");
    expect(await gate.run({ ...actions, choose: second })).toBeNull();
    expect(second).not.toHaveBeenCalled();
    selected("/new");
    expect(await first).toBe("/new");
    expect(open).toHaveBeenCalledExactlyOnceWith("/new");
  });
});
