# Saving and recovery

The editor automatically saves each document 500 ms after typing stops. `Cmd+S` on macOS, `Ctrl+S` elsewhere, and **保存全部** flush all pending documents immediately. The status bar distinguishes pending, saving, saved, and failed states. A file's edits are queued in order even when more changes arrive during a write. Main and split panes share the same document buffer.

Changing projects, closing tabs/panes, compiling, closing the window, and the macOS Quit menu wait for pending writes. Failed writes keep the application open and show a persistent recovery panel. The original file is staged and synced before atomic replacement, instead of being truncated first. Read-only files, missing files, backup failures, and detected external edits stop a save without replacing the original. For a conflict, export a recovery copy and compare it with the disk version; the app does not silently overwrite either.

Unsaved text is also stored as a recovery draft in the application's local storage on every edit (for very large files, at most 250 ms after the last edit). Reopening the project discovers retained drafts, including drafts of files that no longer exist. Use **打开草稿**, **重试保存**, **另存副本**, or **重新读取磁盘版本**. The last action requires confirmation before discarding the draft. Storage errors are shown explicitly. This is recovery protection, not a guarantee against disk failure, OS-level termination, or damaged browser storage.

Before replacing a file, the previous on-disk content is saved in:

```
<project>/.lmms_lab_writer/backups/<relative-file-path>/<timestamp>-<id>.bak
```

**历史备份** lists and previews these versions. Confirming a restore replaces the editor contents and automatically saves it, preserving the current disk version as another backup. Keep any unsaved draft separately before restoring. The latest 30 snapshots per file are retained; this folder is hidden from the editor's file tree. Backups stay on the same local disk. They do not replace an independent backup such as Time Machine.

Recovery copies require a new filename and never overwrite an existing file. Keep the same application identifier and local storage when upgrading to preserve pending drafts. AI edits written directly by OpenCode are outside the editor's save queue; the editor checks for external changes before its own writes, and history snapshots are created for editor saves and, when a selection is attached to a chat request, for that selected file immediately before the request is sent.

## Git 版本与自动快照

顶部“保存 Git 版本”会先保存编辑器中的未保存内容，然后为整个项目创建本地 Git 版本；“Git 历史”可查看差异并恢复当前文本文件。恢复前会先保存一个当前版本，避免丢失现有内容。普通文件自动保存（约 500 ms）和“历史备份”仍独立工作。

“自动 Git · 15 分钟”默认开启，仅在 Writer 打开该项目时运行。每 30 秒检查调度：距上次版本检查／保存满 15 分钟，有内容变化才创建新版本；检测到普通 Git 提交或手动版本保存后重新计时。任务执行中会等两个 Agent 空闲后再保存，避免记录正在写到一半的结果。失败会显示原因，并保留重试机会。关闭应用后不会在系统后台定时执行。

版本存于 `refs/writer/snapshots`，使用临时 Git index 创建 commit，不移动当前分支、不改变用户的暂存区、不自动推送。支持尚未初始化的项目；项目位于另一仓库的子目录（如 `repo/paper/`）时，版本保存在项目内的私有仓库 `.writer/versions.git`，外层仓库不受影响，批注照常保存。

Git 面板的“Discard All”与单文件丢弃会先保存一个 Writer 版本，并且不会触碰 `.writer/`、`.lmms_lab_writer/`（批注、附件、保存备份）。文件遵守 `.gitignore`，并排除 Writer 自身备份、`.DS_Store`、临时目录和依赖缓存。未发生变化不会产生空版本。界面展示最近 100 条记录，旧版本仍保存在 Git 中。

终端查看：`git log --oneline refs/writer/snapshots`。这是一份本地历史；跨设备／磁盘损坏恢复仍需独立备份。
