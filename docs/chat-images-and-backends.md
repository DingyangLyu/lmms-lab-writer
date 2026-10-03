# 图片与双后端

更新：三个后端现已统一支持普通文件附件，使用方式与限制见 [聊天文件附件](chat-file-attachments.md)。下文保留图片视觉输入的配置说明。

OpenCode 和 Codex 的输入栏都有图片按钮，支持原生文件选择、粘贴截图，以及拖入输入区域。每条消息最多 6 张 PNG/JPEG/WebP/GIF，单张不超过 10 MB；发送前可预览、移除，失败时保留草稿和附件。聊天历史中的图片、Markdown 图片和图片工具结果可在应用内放大查看。

Codex 原生 app-server 使用 `turn/start.input` 的 `image` 数据 URL；历史也接受 `localImage` 与 `imageView` 路径。OpenCode 使用 `file` parts，模型必须声明 `capabilities.input.image`。自定义 Kimi Anthropic provider 的模型配置应包含 `attachment: true` 与 `modalities: {input: ["text", "image"], output: ["text"]}`，否则 OpenCode 会过滤图片，即便模型本身支持视觉。本机此配置已备份后修正；无需更改 API key。

后端首次打开后会保持挂载，切换标签或收起 Agent 侧栏只改变显示；各自的连接、会话、草稿、附件及运行状态保持独立。运行中的标签有动态状态点。编译失败的转发消息绑定最初选定的后端，切换不会把同一个任务发送两遍。停止按钮只停止对应后端。退出 Writer 仍会结束其托管进程，已保存的聊天历史可以重读。

验证覆盖图片数据传输／历史、发送前后的预览、两边草稿切换、隐藏面板接收完成事件，以及 Kimi K3、原生 Codex 对测试图的真实识别。
