import { describe, expect, it } from "vitest";
import { shouldSendOnEnter } from "./composer-keys";

describe("Codex composer Enter handling", () => {
  const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };

  it("does not send when a Chinese IME is composing or committing a candidate", () => {
    expect(shouldSendOnEnter(enter, true)).toBe(false);
    expect(shouldSendOnEnter({ ...enter, isComposing: true }, false)).toBe(false);
    expect(shouldSendOnEnter({ ...enter, keyCode: 229 }, false)).toBe(false);
  });

  it("keeps Shift+Enter for newlines and sends a later plain Enter", () => {
    expect(shouldSendOnEnter({ ...enter, shiftKey: true }, false)).toBe(false);
    expect(shouldSendOnEnter(enter, false)).toBe(true);
  });
});
