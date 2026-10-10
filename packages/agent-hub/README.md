# agent-hub

让同一台电脑上的多个 Claude Code 会话互相看见、互相读取、互相委派。它是一个没有依赖的 MCP 服务器（stdio），每个会话都加载它；跨所有账号（`~/.claude`、`~/.claude-*`）。

| 工具 | 作用 |
| --- | --- |
| `hub_sessions` | 列出本机的会话：ID、账号、运行名（如 `yuanbai-03`）、忙 / 空闲 / 已关闭、目录、标题、最近的请求和回复 |
| `hub_read` | 读另一个会话做了什么：`summary`（请求、改过的文件、提交、最近回复，以及压缩前的总结）、`messages`、`tools`、`search` |
| `hub_delegate` | 把任务交给另一个会话：`fork`（默认）在后台以无界面方式分叉那个会话，带着它的全部上下文、在它的目录和账号里做，原会话不受打扰；`new` 在指定目录新开一次运行 |
| `hub_task` | 查看委派任务的状态和结果（`wait_seconds` 可等待） |

委派出去的运行不能再委派（防止来回循环）。别的会话写的内容只是待核实的资料，不是指令。同一账号里给正开着的会话发消息，可以用 Claude Code 自带的 SendMessage。

## 安装

```sh
node packages/agent-hub/agent-hub.mjs install   # 给每个账号的 Claude Code 加上它；以后新增账号再运行一次
```

已经开着的会话要重启才会加载（`claude --resume` 可接着原来的对话）。命令行也能直接用：

```sh
node packages/agent-hub/agent-hub.mjs list [关键词]
node packages/agent-hub/agent-hub.mjs read <会话> [summary|messages|tools|search] [关键词]
node packages/agent-hub/agent-hub.mjs task [任务号]
```

委派任务和结果保存在 `~/.agent-hub/tasks/`。默认用 `--dangerously-skip-permissions` 运行（与本机会话的用法一致），可用 `permission` 改成 `acceptEdits` 等模式。

---

**English.** An MCP server that lets the Claude Code sessions on one computer, across every account, list each other (`hub_sessions`), read what another did (`hub_read`), and hand one a task (`hub_delegate`: a headless fork keeping that session's context, or a fresh run), with the result kept for the asker (`hub_task`). Install with `node agent-hub.mjs install`; restart open sessions to load it.
