export const tasksZh = {
  "tasks.title": "共享任务",
  "tasks.lead":
    "任务使用提交时的项目快照，AI 输出进入“审阅”；编译 PDF 作为新产物保存。执行器断线会报告失败，不会覆盖正文。",
  "tasks.harness": "任务执行环境",
  "tasks.compile": "编译 · {engine}",
  "tasks.prompt": "共享任务要求",
  "tasks.compilePlaceholder": "主文件相对路径，例如 main.tex",
  "tasks.promptPlaceholder": "描述需要修改的内容…",
  "tasks.submit": "加入共享任务队列",
  "tasks.runner": "连接本机执行器",
  "tasks.runnerLead":
    "为此项目创建能力受限的令牌。编译使用隔离 Docker 容器；AI 由你自己的本机 CLI 执行，仅为可信合作者启用。登录凭据不上传到服务端。",
  "tasks.runnerDesktop":
    "也可以在 Writer 桌面端打开这个项目，在“多人协作”中开启“用这台电脑执行组员提交的 AI 任务”。",
  "tasks.runnerName": "本机执行器",
  "tasks.createToken": "创建当前能力的执行器令牌",
  "tasks.token": "令牌（仅显示本次）",
  "tasks.tokenLabel": "执行器令牌",
  "tasks.copyToken": "复制令牌",
  "tasks.tokenHint":
    "按部署说明设置 WRITER_RUNNER_TOKEN，然后启动 runner。不要把此令牌发给其他人。",
  "tasks.status.queued": "排队中",
  "tasks.status.running": "执行中",
  "tasks.status.completed": "已完成",
  "tasks.status.failed": "失败",
  "tasks.status.cancelled": "已取消",
  "tasks.result": "结果 / 日志",
  "tasks.cancel": "取消任务",
};
export const tasksEn: Record<keyof typeof tasksZh, string> = {
  "tasks.title": "Shared tasks",
  "tasks.lead":
    "Tasks run on the project as it was when submitted. AI output goes to Review; a compiled PDF is saved as a new artifact. If a runner disconnects the task fails; the manuscript is never overwritten.",
  "tasks.harness": "Runs with",
  "tasks.compile": "Compile · {engine}",
  "tasks.prompt": "Task",
  "tasks.compilePlaceholder": "Main file path, e.g. main.tex",
  "tasks.promptPlaceholder": "Describe the change you want…",
  "tasks.submit": "Add to the shared queue",
  "tasks.runner": "Connect a runner",
  "tasks.runnerLead":
    "Creates a limited token for this project. Builds run in an isolated Docker container; AI tasks run with your own local CLI, so only enable it for trusted co-authors. Sign-in credentials are never uploaded.",
  "tasks.runnerDesktop":
    "You can also open this project in the Writer desktop app and turn on “Run teammates' AI tasks on this computer” under Collaborate.",
  "tasks.runnerName": "Local runner",
  "tasks.createToken": "Create a runner token for this tool",
  "tasks.token": "Token (shown only once)",
  "tasks.tokenLabel": "Runner token",
  "tasks.copyToken": "Copy token",
  "tasks.tokenHint":
    "Set WRITER_RUNNER_TOKEN as described in the deployment guide, then start the runner. Do not share this token.",
  "tasks.status.queued": "Queued",
  "tasks.status.running": "Running",
  "tasks.status.completed": "Completed",
  "tasks.status.failed": "Failed",
  "tasks.status.cancelled": "Cancelled",
  "tasks.result": "Result / log",
  "tasks.cancel": "Cancel task",
};
