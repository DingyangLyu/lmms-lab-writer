import { describe, expect, it } from "vitest";
import { canClose, focusConversation, newTab, restoreWorkspace, updateConversation } from "./workspace";

describe("concurrent conversation identity", () => {
  it("focuses the last conversation for a backend without creating a replacement", () => {
    const codex = newTab("codex", "codex-1", "Codex research");
    const openCode = newTab("opencode", "open-1", "OpenCode research");
    const state = { tabs: [codex, openCode], activeId: openCode.id, lastActive: { codex: codex.id, opencode: openCode.id } };
    const next = focusConversation(state, "codex");
    expect(next?.activeId).toBe(codex.id);
    expect(next?.tabs).toHaveLength(2);
  });
  it("preserves stable UI identity when the backend lazily assigns a session ID", () => {
    const a = newTab("codex"),
      b = newTab("codex");
    const state = { tabs: [a, b], activeId: a.id };
    const next = updateConversation(state, a.id, {
      ...a,
      sessionId: "native-a",
      status: "running",
    });
    expect(next.tabs[0]?.id).toBe(a.id);
    expect(next.tabs[1]).toBe(b);
    expect(next.activeId).toBe(a.id);
    expect(next.tabs[1]?.status).toBe("connecting");
  });
  it("restores many same-harness sessions but deduplicates the same native conversation", () => {
    const a = newTab("opencode", "a"),
      b = newTab("opencode", "b");
    const saved = restoreWorkspace(
      JSON.stringify({ tabs: [a, b, { ...a, id: "duplicate" }], activeId: b.id }),
    );
    expect(saved.tabs.map((t) => t.sessionId)).toEqual(["a", "b"]);
    expect(saved.activeId).toBe(b.id);
  });
  it("never closes a running/waiting conversation or discards drafts and queued work", () => {
    const tab = { ...newTab("claude"), status: "idle" as const };
    expect(canClose(tab)).toBe(true);
    expect(canClose({ ...tab, status: "running" })).toBe(false);
    expect(canClose({ ...tab, status: "waiting" })).toBe(false);
    expect(canClose({ ...tab, queued: 2 })).toBe(false);
    expect(canClose({ ...tab, hasDraft: true })).toBe(false);
  });
  it("rejects malformed persisted backend data and resets stale execution flags", () => {
    const tab = newTab("codex", "a");
    const restored = restoreWorkspace(
      JSON.stringify({
        tabs: [
          { ...tab, status: "running", queued: 3 },
          { id: "x", backend: "invalid" },
        ],
        activeId: "missing",
      }),
    );
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]?.status).toBe("connecting");
    expect(restored.activeId).toBe(tab.id);
  });
});

describe("temporary conversation tabs", () => {
  it("reuses an untouched draft and discards it when choosing another backend", async () => {
    const { openConversation } = await import("./workspace");
    const first = openConversation(
      { tabs: [], activeId: null },
      "opencode",
      null,
      undefined,
      new Set(),
    );
    const second = openConversation(first, "opencode", null, undefined, new Set());
    expect(second.tabs).toHaveLength(1);
    expect(second.activeId).toBe(first.activeId);
    const third = openConversation(second, "codex", null, undefined, new Set());
    expect(third.tabs).toHaveLength(1);
    expect(third.tabs[0]?.backend).toBe("codex");
  });
  it("preserves unsent text, active work and pending deliveries when opening a new draft", async () => {
    const { openConversation } = await import("./workspace");
    const draft = { ...newTab("codex"), hasDraft: true },
      running = { ...newTab("claude"), status: "running" as const },
      pending = newTab("opencode");
    const next = openConversation(
      { tabs: [draft, running, pending], activeId: draft.id },
      "codex",
      null,
      undefined,
      new Set([pending.id]),
    );
    expect(next.tabs).toHaveLength(4);
    expect(next.tabs).toContain(draft);
    expect(next.tabs).toContain(running);
  });
  it("persists talked-to sessions and paused external tasks, never unused placeholders", async () => {
    const { serializeWorkspace } = await import("./workspace");
    const empty = newTab("codex"),
      pending = newTab("claude"),
      conversation = newTab("opencode", "native-history");
    const saved = restoreWorkspace(
      serializeWorkspace(
        { tabs: [empty, pending, conversation], activeId: empty.id },
        new Set([pending.id]),
      ),
    );
    expect(saved.tabs.map((t) => t.id)).toEqual([pending.id, conversation.id]);
    expect(saved.activeId).toBe(conversation.id);
  });
  it("opening a historical conversation focuses its existing tab and keeps its task", async () => {
    const { openConversation } = await import("./workspace");
    const running = { ...newTab("codex", "existing"), status: "running" as const },
      blank = newTab("codex");
    const next = openConversation(
      { tabs: [running, blank], activeId: blank.id },
      "codex",
      "existing",
      "saved name",
      new Set(),
    );
    expect(next.tabs).toEqual([running]);
    expect(next.activeId).toBe(running.id);
  });
});
it("keeps a restored native conversation identity and title while its adapter connects", () => {
  const tab = newTab("codex", "history-id", "Saved paper discussion");
  const state = { tabs: [tab], activeId: tab.id };
  const next = updateConversation(state, tab.id, {
    sessionId: null,
    title: "新 Codex 对话",
    status: "connecting",
    hasDraft: false,
    queued: 0,
  });
  expect(next.tabs[0]?.sessionId).toBe("history-id");
  expect(next.tabs[0]?.title).toBe("Saved paper discussion");
});
