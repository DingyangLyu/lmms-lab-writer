import { describe, expect, it } from "vitest";
import { openedProjectPath, rememberProjectRoot, sameProject } from "./project-root";

describe("project roots", () => {
  it("maps canonical backend roots to the path the user opened", () => {
    rememberProjectRoot("/Users/me/link/paper", "/Volumes/data/paper");
    expect(openedProjectPath("/Volumes/data/paper")).toBe("/Users/me/link/paper");
    expect(sameProject("/Volumes/data/paper", "/Users/me/link/paper")).toBe(true);
    expect(sameProject("/Volumes/data/other", "/Users/me/link/paper")).toBe(false);
    expect(openedProjectPath("/unrelated")).toBe("/unrelated");
  });
});
