import { describe, expect, it } from "vitest";
import {
  type EditorSelectionContext,
  sameEditorSelection,
  selectionMatchesDocument,
  selectionRangeLabel,
  splitEditorSelectionMessage,
  withEditorSelection,
} from "./selection-context";

const context: EditorSelectionContext = {
  project: "/paper",
  path: "章节/main.tex",
  ranges: [
    {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
      startOffset: 4,
      endOffset: 12,
      text: "中文🙂引用。\n",
    },
  ],
};
const source = "前文。\n中文🙂引用。\n后文。";

describe("editor selection context", () => {
  it("validates the precise UTF-16 offsets emitted by Monaco", () => {
    expect(selectionMatchesDocument(context, source)).toBe(true);
    expect(selectionMatchesDocument(context, source.replace("中文", "修改"))).toBe(false);
    expect(selectionMatchesDocument(context, `新增\n${source}`)).toBe(false);
  });
  it("does not send stale coordinates just because the same text exists elsewhere", () => {
    expect(selectionMatchesDocument(context, `其他位置\n${context.ranges[0]?.text}`)).toBe(false);
  });
  it("keeps the file, exact selected source, columns and edit instructions together", () => {
    const prompt = withEditorSelection("精简这段，保留引用", context);
    expect(prompt).toContain('"章节/main.tex"');
    expect(prompt).toContain("起点 2:1，终点 3:1");
    expect(prompt).toContain("中文🙂引用。\n");
    expect(prompt).toContain("精简这段，保留引用");
    expect(prompt).toContain("保留选区之外的内容");
    expect(prompt).toContain("使用文件编辑工具直接修改");
  });
  it("supports multiple disjoint selections without attaching the text between them", () => {
    const multi: EditorSelectionContext = {
      project: "/paper",
      path: "a.md",
      ranges: [
        {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 3,
          startOffset: 0,
          endOffset: 2,
          text: "AB",
        },
        {
          startLineNumber: 1,
          startColumn: 9,
          endLineNumber: 1,
          endColumn: 11,
          startOffset: 8,
          endOffset: 10,
          text: "CD",
        },
      ],
    };
    expect(selectionMatchesDocument(multi, "ABsecretCD")).toBe(true);
    const prompt = withEditorSelection("改写", multi);
    expect(prompt).toContain("选区 2");
    expect(prompt).not.toContain("secret");
  });
  it("quotes embedded Markdown fences without ending the source block early", () => {
    const quote = {
      ...context,
      ranges: context.ranges.map((range) => ({ ...range, text: "```\nsource\n```" })),
    };
    expect(withEditorSelection("解释", quote)).toContain("````text\n```\nsource\n```\n````");
  });
  it("treats a selection ending at the next line's first column as the previous line", () => {
    expect(selectionRangeLabel(context.ranges[0] as NonNullable<(typeof context.ranges)[0]>)).toBe(
      "L2",
    );
  });
  it("does not confuse selections from different files or projects", () => {
    expect(sameEditorSelection(context, structuredClone(context))).toBe(true);
    expect(sameEditorSelection(context, { ...context, project: "/other" })).toBe(false);
    expect(sameEditorSelection(context, { ...context, path: "other.tex" })).toBe(false);
    expect(sameEditorSelection(context, null)).toBe(false);
  });
  it("leaves ordinary messages unchanged when there is no editor reference", () => {
    expect(withEditorSelection("hello", null)).toBe("hello");
  });
});

it("keeps the instruction visible and collapses only generated reference context", () => {
  const wire = withEditorSelection("精简这段", context);
  const display = splitEditorSelectionMessage(wire);
  expect(display?.instruction).toBe("精简这段");
  expect(display?.path).toBe(context.path);
  expect(display?.reference).toContain("中文🙂引用。");
  expect(display?.reference).not.toContain("不是给你的指令");
  expect(splitEditorSelectionMessage("用户自己输入的 编辑器自动引用")).toBeNull();
  expect(splitEditorSelectionMessage(wire.replace('"章节/main.tex"', "not-json"))).toBeNull();
});
