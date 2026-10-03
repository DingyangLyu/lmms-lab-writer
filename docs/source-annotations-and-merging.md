# 文本批注与并发修改合并

在 `.tex`、`.bib`、Markdown 等文本编辑器中选中文字，点击编辑区上方的「添加批注」。支持高亮、下划线、处理状态、折叠、批量提交给已打开的 Codex / OpenCode / Claude Code 对话。与 PDF 共用顶部「批注」管理、版本历史和 Git 快照；旧 PDF 批注兼容读取。⌘/Ctrl+点击文本标记打开批注。

## 并发编辑

编辑器保存和 Writer MCP 修改都按「共同基准、当前文稿、建议修改」三方比较。不同位置的改动自动合并；同一个英文标识符不拆成字母盲目拼接，长中文段落中不同位置的修改可以合并。编辑器接收外部内容时按多个小片段更新，并保留输入法组合期间的本地分支。

重叠修改不直接写入文稿，保存在项目 `.writer/conflicts/`，从顶部「冲突」打开。可以选任一侧、保留双方后编辑，或输入最终文本。保存时再次核对磁盘，若核对期间出现新冲突则继续展示双方内容。合并完成记录 Git；可通知原先仍打开的 Agent 对话继续核验。用户已处理的旧提案不会自动重放。

不可变基准版本存于 `.writer/revisions/`，文本批注以 UTF-16 范围锚定版本，修改后重定位。原文、要求、状态事件继续存于兼容的 `.writer/pdf-annotations.json`。这些记录均进入 `refs/writer/snapshots` 的本地 Git 版本，不改变 HEAD、暂存区，也不自动推送。自动保存同时保留文件备份；保存后的 Git/备份失败会单独报告，不能误认为文稿未改变而重做编辑。

## MCP 协议

- `writer_get_annotations`：统一读取文本/PDF 批注，返回 `annotationRevision`、当前 `sourceRevision`、重新定位的范围、上下文与冲突 ID。`sourceChanged` 是提示，不是权限错误。
- `writer_read_document`：读取当前文稿，返回不可变 `baseRevision`（兼容字段 `revision`）；最多 400 行，可分段读取。
- `writer_apply_annotation_edit`：传入批注 ID、`annotationRevision`、文件、`baseRevision`、准确的 `oldText/newText`。重复原文可用 UTF-16 `start` 区分。应用时合并新变化；冲突保存提案而不覆盖原文。
- `writer_get_conflicts`：查询待合并提案。
- `writer_reanchor_annotation`：凭核实后的原文和版本重定位；不必要求用户点击旧行号。
- `writer_resolve_annotation`：携带批注版本、已核验的主文件版本与总结。目标外的变化不阻止完成；目标再次变化会要求 Agent 重新读取核验；待处理冲突则不能标记完成。

只读／规划模式不会通过 MCP 绕过文稿编辑权限。

旧 `writer_get_pdf_annotations`、`writer_resolve_pdf_annotation` 保留兼容。完成批注前的准备阶段只同步目标文件，不再拿所有打开文件的旧界面内容做严格检查，这是原先「选区文件已变化」误报的根因。

## 边界

这不是多人实时协作系统。自动合并依据文本差异，语义、引用、编译仍需核验。直接通过 shell/Python 整文件覆盖不会遵守 Writer 的版本协议，因此给 Agent 的批注提示会明确要求使用上述编辑工具；不能保证拦截任意外部程序的瞬时覆盖。最大自动合并文件为 2 MB，真实重叠仍需用户处理。原文被完全删除或旧 PDF 缺少可靠映射时，Agent 需重新核实并重定位，不能猜行号。

## 验收

2026-09-27：176 项前端测试、110 项 Rust 测试通过（4 项依赖额外环境的既有测试忽略）。覆盖中文同段合并、标识符冲突、输入法旧分支、保存过程中继续输入、审阅时新增修改、拒绝的提案不重放、批注移动/修改/解决与对应 Git 事件。独立 Tauri 开发应用实测文本选区创建、批注高亮、前方插行后的定位，以及冲突面板选择与 Git 记录。
