import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodexMarkdown } from "./codex-markdown";

describe("Codex Markdown in a narrow sidebar", () => {
  it("renders a Chinese GFM comparison table inside its own scroll region", () => {
    const markdown = [
      "| 论文主线 | 当前实现 |",
      "| --- | --- |",
      "| 可扩展 | 资产注册表把角色、技能和工作流组成有版本关系的资产图。 |",
      "| 可控执行 | 工作流支持审批、恢复与溯源。 |",
    ].join("\n");

    const html = renderToStaticMarkup(createElement(CodexMarkdown, { text: markdown }));

    expect(html).toContain('class="codex-markdown-table"');
    expect(html).toContain('aria-label="回答表格，可横向滚动"');
    expect(html).toContain("<table>");
    expect(html).toContain("<th>论文主线</th>");
    expect(html).toContain("<td>可扩展</td>");
    expect(html).toContain("资产注册表把角色、技能和工作流组成有版本关系的资产图。");
  });
});
