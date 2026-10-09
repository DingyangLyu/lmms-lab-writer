import { describe, expect, it } from "vitest";
import { type TeamComment, teamMarks } from "./team-comments";

const comment = (over: Partial<TeamComment>): TeamComment => ({
  id: "c1",
  file: "f1",
  path: "main.tex",
  author: "u1",
  authorName: "lab",
  quote: "barrier",
  body: "Which barrier?",
  resolved: false,
  created: 1,
  edited: null,
  from: 16,
  to: 23,
  line: 2,
  excerpt: "barrier",
  pdf: null,
  replies: [],
  ...over,
});
const TEXT = "\\section{Intro}\nbarrier is low.\n";

describe("team comments on the local text", () => {
  it("marks the anchored text when the local copy matches the server", () => {
    const [mark] = teamMarks([comment({})], "main.tex", TEXT);
    expect(mark?.id).toBe("team:c1");
    expect(mark?.ranges[0]).toMatchObject({ start: 16, end: 23, text: "barrier", line: 2 });
  });
  it("finds the text again after unsynced edits before it", () => {
    const local = `% local note\n${TEXT}`;
    const [mark] = teamMarks([comment({})], "main.tex", local);
    expect(local.slice(mark?.ranges[0]?.start, mark?.ranges[0]?.end)).toBe("barrier");
    expect(mark?.ranges[0]?.line).toBe(3);
  });
  it("leaves out resolved threads, other files and text that no longer exists", () => {
    expect(teamMarks([comment({ resolved: true })], "main.tex", TEXT)).toEqual([]);
    expect(teamMarks([comment({ path: "intro.tex" })], "main.tex", TEXT)).toEqual([]);
    expect(teamMarks([comment({})], "main.tex", "\\section{Intro}\nwall.\n")).toEqual([]);
    expect(teamMarks([comment({ from: null, to: null })], "main.tex", TEXT)).toEqual([]);
  });
});
