import { expect, it } from "vitest";
import { clampPanelHeight } from "./panel-height";

it("caps both panels at half of their container, including small windows", () => {
  expect(clampPanelHeight(900, 800, 140)).toBe(400);
  expect(clampPanelHeight(50, 800, 140)).toBe(140);
  expect(clampPanelHeight(900, 200, 140)).toBe(100);
  expect(clampPanelHeight(300, 1000, 96)).toBe(300);
});
