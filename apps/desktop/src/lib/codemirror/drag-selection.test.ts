import { describe, expect, it } from "vitest";
import { DragSelectionState } from "./drag-selection";

describe("WebKit continuous drag selection", () => {
  it("keeps the primary button held through broken WebKit move events until release", () => {
    const drag = new DragSelectionState();
    expect(drag.begin(0, 0, true)).toBe(true);
    expect([0, 0, 0].map((buttons) => drag.normalizeButtons(buttons))).toEqual([1, 1, 1]);
    expect(drag.finish()).toBe(true);
    expect(drag.normalizeButtons(0)).toBe(0);
  });

  it("leaves normal mouse events and non-WebKit gestures unchanged", () => {
    const drag = new DragSelectionState();
    drag.begin(0, 1, true);
    expect(drag.normalizeButtons(1)).toBe(1);
    expect(drag.normalizeButtons(0)).toBe(0);
    drag.finish();
    drag.begin(0, 0, false);
    expect(drag.normalizeButtons(0)).toBe(0);
  });

  it("does not latch right clicks or carry a held button past blur/cancel", () => {
    const drag = new DragSelectionState();
    expect(drag.begin(2, 0, true)).toBe(false);
    expect(drag.normalizeButtons(0)).toBe(0);
    drag.begin(0, 0, true);
    drag.finish();
    expect(drag.finish()).toBe(false);
    expect(drag.normalizeButtons(0)).toBe(0);
    drag.begin(0, 1, true);
    expect(drag.normalizeButtons(0)).toBe(0);
  });
});
