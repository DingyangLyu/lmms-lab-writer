import { describe, expect, it } from "vitest";
import type { Build, Comment } from "../../shared/api";
import { buildTask, commentsTask } from "./ai-tasks";

const comment: Comment = {
  id: "c1",
  file: "f1",
  author: "u1",
  authorName: "lin",
  quote: "We present MatOS",
  start: "",
  end: "",
  body: "Say what MatOS stands for",
  resolved: false,
  created: 1,
  updated: 1,
  edited: null,
  from: 10,
  to: 26,
  line: 4,
  excerpt: "We present MatOS",
  pdf: {
    fingerprint: "x",
    style: "highlight",
    marks: [{ page: 2, x: 0, y: 0, width: 1, height: 1 }],
  },
  replies: [
    {
      id: "r1",
      comment: "c1",
      author: "u2",
      authorName: "wang",
      body: "```and cite it```",
      created: 2,
      edited: null,
    },
  ],
};

describe("tasks for the AI conversation", () => {
  it("quotes each comment with its file, line, page, request and discussion", () => {
    const text = commentsTask(
      [comment],
      [{ id: "f1", path: "sections/intro.tex", binary: false, revision: 1 }],
      "zh",
    );
    expect(text).toContain("请处理下面 1 条批注");
    expect(text).toContain("批注 1 · sections/intro.tex · 第 4 行 · PDF 第 2 页");
    expect(text).toContain("We present MatOS");
    expect(text).toContain("修改要求 (lin)");
    // A reply with backticks cannot close the block it is quoted in.
    expect(text).toContain("````text\nwang: ```and cite it```\n````");
    expect(commentsTask([comment], [], "en")).toContain("Comment 1 · f1 · line 4");
  });

  it("hands over a failed build's errors and the end of its log", () => {
    const build: Build = {
      id: "b1",
      main: "main.tex",
      engine: "xelatex",
      status: "failed",
      issues: [
        { level: "error", file: "main.tex", line: 34, message: "Undefined control sequence" },
        { level: "warning", file: "main.tex", line: 2, message: "Overfull \\hbox" },
      ],
      log: `${"x".repeat(20_000)}END`,
      pdf: false,
      duration: 1000,
      created: 1,
      author: "u1",
    };
    const text = buildTask(build, "en");
    expect(text).toContain("Main file: main.tex · Engine: xelatex");
    expect(text).toContain("- main.tex:34 Undefined control sequence");
    expect(text).not.toContain("Overfull");
    expect(text).toContain("END");
    expect(text.length).toBeLessThan(13_500);
  });
});
