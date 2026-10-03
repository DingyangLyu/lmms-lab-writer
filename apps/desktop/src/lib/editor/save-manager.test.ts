import { mergeText } from "@lmms-lab/writing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Draft, projectRelativePath, SaveManager } from "./save-manager";

class MemoryStorage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("document saving", () => {
  it("saves two rapidly edited files independently", async () => {
    const write = vi.fn(async (_draft: Draft) => {});
    const manager = new SaveManager(write, new MemoryStorage());
    manager.open("/p", "a.tex", "a");
    manager.open("/p", "b.tex", "b");
    manager.edit("/p", "a.tex", "甲");
    manager.edit("/p", "b.tex", "乙");
    await vi.advanceTimersByTimeAsync(500);
    expect(write.mock.calls.map(([draft]) => [draft.path, draft.content])).toEqual([
      ["a.tex", "甲"],
      ["b.tex", "乙"],
    ]);
  });
  it("serializes edits arriving during an in-flight save", async () => {
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = vi.fn(async (_draft: Draft) => {});
    write.mockImplementationOnce(() => gate);
    const manager = new SaveManager(write, new MemoryStorage());
    manager.open("/p", "a", "original");
    manager.edit("/p", "a", "first");
    const saving = manager.flushAll();
    manager.edit("/p", "a", "latest");
    expect(write).toHaveBeenCalledTimes(1);
    finish();
    await saving;
    expect(write.mock.calls.map(([draft]) => [draft.base, draft.content])).toEqual([
      ["original", "first"],
      ["first", "latest"],
    ]);
    expect(manager.get("/p", "a")?.dirty).toBe(false);
  });
  it("retains failed content and rejects the flush used by closing/project changes", async () => {
    const storage = new MemoryStorage();
    const write = vi.fn(async (_draft: Draft): Promise<void> => {
      throw new Error("disk full");
    });
    const manager = new SaveManager(write, storage);
    manager.open("/p", "a", "old");
    manager.edit("/p", "a", "new");
    await expect(manager.flushAll()).rejects.toThrow("disk full");
    expect(manager.get("/p", "a")).toMatchObject({
      dirty: true,
      saving: false,
      content: "new",
      error: "disk full",
    });
    expect([...storage.data.values()][0]).toContain("new");
    write.mockImplementation(async () => {});
    await manager.flushAll();
    expect(storage.length).toBe(0);
  });
  it("restores drafts after a crash without overwriting the external disk version", async () => {
    const storage = new MemoryStorage();
    const manager = new SaveManager(async () => {}, storage, 100000);
    manager.open("/p", "a", "old");
    manager.edit("/p", "a", "draft");
    const write = vi.fn(async (_draft: Draft) => {});
    const restarted = new SaveManager(write, storage);
    await restarted.recoverProject("/p", async () => "external");
    expect(restarted.get("/p", "a")).toMatchObject({
      content: "draft",
      base: "old",
      dirty: true,
      recovered: true,
    });
    expect(write).not.toHaveBeenCalled();
    expect(restarted.open("/p", "a", "external")).toBe("draft");
  });
  it("retains a recoverable draft even when its disk file has been deleted", async () => {
    const storage = new MemoryStorage();
    const manager = new SaveManager(async () => {}, storage);
    manager.open("/p", "a", "old");
    manager.edit("/p", "a", "draft");
    const restarted = new SaveManager(async () => {}, storage);
    await restarted.recoverProject("/p", async () => {
      throw new Error("missing");
    });
    expect(restarted.get("/p", "a")?.content).toBe("draft");
  });
  it("keeps identically named files in different projects separate", async () => {
    const write = vi.fn(async (_draft: Draft) => {});
    const manager = new SaveManager(write, new MemoryStorage());
    for (const project of ["/one", "/two"]) {
      manager.open(project, "main.tex", "");
      manager.edit(project, "main.tex", project);
    }
    await manager.flushAll();
    expect(write.mock.calls.map(([draft]) => draft.project)).toEqual(["/one", "/two"]);
  });
  it("manual save flushes the debounce immediately and does not duplicate the write", async () => {
    const write = vi.fn(async (_draft: Draft) => {});
    const manager = new SaveManager(write, new MemoryStorage());
    manager.open("/p", "a", "");
    manager.edit("/p", "a", "text");
    await manager.flushAll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite a dirty buffer when a watcher reload arrives", () => {
    const manager = new SaveManager(async () => {}, new MemoryStorage());
    manager.open("/p", "a", "old");
    manager.edit("/p", "a", "draft");
    expect(manager.open("/p", "a", "external")).toBe("draft");
  });
  it("reports unavailable recovery storage while still allowing a successful disk save", async () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error("quota");
    };
    const manager = new SaveManager(async () => {}, storage);
    manager.open("/p", "a", "");
    manager.edit("/p", "a", "text");
    expect(manager.get("/p", "a")?.draftError).toContain("写入失败");
    await manager.flushAll();
    expect(manager.get("/p", "a")).toMatchObject({ dirty: false, draftError: null });
  });
  it("does not recover a stale draft already saved before the crash", () => {
    const storage = new MemoryStorage();
    const manager = new SaveManager(async () => {}, storage);
    manager.open("/p", "a", "old");
    manager.edit("/p", "a", "new");
    const restarted = new SaveManager(async () => {}, storage);
    expect(restarted.open("/p", "a", "new")).toBe("new");
    expect(restarted.get("/p", "a")?.dirty).toBe(false);
  });
});

it("normalizes agent file links to the same project-relative buffer", () => {
  expect(projectRelativePath("/project", "/project/main.tex")).toBe("main.tex");
  expect(projectRelativePath("/project", "file:///project/%E4%B8%AD%E6%96%87.md")).toBe("中文.md");
  expect(projectRelativePath("C:/Project", "c:/project/main.tex")).toBe("main.tex");
  expect(projectRelativePath("/project", "./main.tex")).toBe("main.tex");
  expect(projectRelativePath("/project", "/outside/main.tex")).toBe("/outside/main.tex");
});

describe("concurrent document merging", () => {
  it("synchronizes clean buffers before agent delivery instead of checking stale editor text", async () => {
    let disk = "old";
    const write = vi.fn(async (_: Draft) => {});
    const manager = new SaveManager(write, new MemoryStorage(), 500, async () => disk);
    manager.open("/p", "a", "old");
    disk = "agent version";
    await manager.synchronize("/p", ["a"]);
    expect(manager.get("/p", "a")?.content).toBe(disk);
    expect(write).not.toHaveBeenCalled();
  });
  it("keeps IME changes based on an older view and newer external changes", async () => {
    const manager = new SaveManager(async () => {}, new MemoryStorage());
    manager.open("/p", "a", "甲段\n乙段");
    manager.open("/p", "a", "甲新段\n乙段");
    manager.edit("/p", "a", "甲段\n乙新段", "甲段\n乙段");
    expect(manager.get("/p", "a")?.content).toBe("甲新段\n乙新段");
    expect(manager.get("/p", "a")?.localConflict).toBeFalsy();
  });
  it("persists both IME and external versions when the same identifier changes", async () => {
    const storage = new MemoryStorage(),
      manager = new SaveManager(async () => {}, storage);
    manager.open("/p", "a", "cat");
    manager.open("/p", "a", "bat");
    manager.edit("/p", "a", "car", "cat");
    await expect(manager.flushAll()).rejects.toThrow("冲突");
    const restarted = new SaveManager(async () => {}, storage);
    restarted.open("/p", "a", "bat");
    expect(restarted.get("/p", "a")?.localConflict).toMatchObject({
      base: "cat",
      ours: "car",
      theirs: "bat",
    });
  });
  it("preserves typing that arrives while an external merge is being saved", async () => {
    let finish = () => {};
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    let disk = "甲新段\n乙段";
    let count = 0;
    const manager = new SaveManager(async (draft) => {
      if (count++ === 0) await gate;
      const result = mergeText(draft.base, draft.content, disk);
      if (result.content === null) throw new Error("unexpected conflict");
      disk = result.content;
      return { status: "saved", content: disk, merged: disk !== draft.content };
    }, new MemoryStorage());
    manager.open("/p", "a", "甲段\n乙段");
    manager.edit("/p", "a", "甲段\n乙改段");
    const saving = manager.flushAll();
    manager.edit("/p", "a", "甲段\n乙改段\n继续输入");
    finish();
    await saving;
    expect(disk).toBe("甲新段\n乙改段\n继续输入");
    expect(manager.get("/p", "a")).toMatchObject({ content: disk, dirty: false });
  });
  it("rebases later typing when a conflict review returns instead of replacing the latest draft", async () => {
    let disk = "已核对\n乙段";
    const manager = new SaveManager(async (draft) => {
      const merged = mergeText(draft.base, draft.content, disk);
      if (merged.content === null) throw new Error("conflict");
      disk = merged.content;
      return { status: "saved", content: disk, merged: true };
    }, new MemoryStorage());
    manager.open("/p", "a", "我的稿\n乙段");
    manager.edit("/p", "a", "我的稿\n乙新段");
    await manager.acceptResolved("/p", "a", disk, "我的稿\n乙段");
    expect(disk).toBe("已核对\n乙新段");
  });
});
