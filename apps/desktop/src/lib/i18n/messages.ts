export const msgZh = {
  "msg.pathMatchesSeveralFilesGiveAPathRelative":
    "“{path}”对应多个文件，请指定项目相对路径：{matches}",
  "msg.listSeparator": "、",
  "msg.closingWasCancelledBecauseSomeFilesAreNo":
    "关闭已取消：有文件尚未保存。请重试或另存副本。{error}",
  "msg.closeProtectionIsNotActiveError": "关闭保护未启用：{error}",
  "msg.couldNotWriteTheLocalRecoveryDraftStorag":
    "本地恢复草稿写入失败（存储空间可能不足）。请立即保存或另存副本，保持应用打开。",
  "msg.twoSetsOfEditorChangesConflictMergeThemI":
    "编辑器两处修改存在冲突，请在冲突面板中合并；双方草稿已保留。",
  "msg.overlappingChangesWereFoundAndBothVersio":
    "发现重叠修改，双方内容已保留，请打开“冲突”合并。",
  "msg.couldNotReadTheLocalRecoveryDraftKeepThe":
    "无法读取本地恢复草稿。请保持应用打开并保存文件。",
  "msg.theFileHasNotBeenReadYetSoItCannotBeSave": "文件尚未读取，不能保存。请重新打开文件。",
  "msg.theEditorChangesConflictOpenTheConflictP": "编辑器修改存在冲突，请打开冲突面板。",
  "msg.theFileWasSavedButTheOldRecoveryDraftCou": "文件已保存，但旧恢复草稿清理失败。",
  "msg.theDraftChangedAgainReopenTheConflictPan": "草稿又有修改，请重新打开冲突面板。",
  "msg.savingIsInProgressTryAgainInAMoment": "正在保存，请稍后重试。",
  "msg.externalChangesWereMergedAutomatically": "已自动合并外部修改",
  "msg.theSelectedTextHasChangedSelectItAgainBe":
    "选区原文已变化，请重新选择后再发送，避免修改错误位置。",
  "msg.theProjectChangedSelectTheTextToQuoteAga": "项目已切换，请重新选择需要引用的文本。",
  "msg.savingBeforeDelegationFailedError": "委派前保存失败：{error}",
  "msg.theGitAutoSaveCheckFailedError": "Git 自动保存检查失败：{error}",
  "msg.couldNotSaveAGitVersionError": "Git 版本保存失败：{error}",
  "msg.savedGitVersionHash": "已保存 Git 版本 {hash}",
  "msg.noNewChangesTheGitVersionIsUpToDate": "没有新改动，Git 版本已是最新",
  "msg.untitledOpencodeConversation": "未命名 OpenCode 对话",
  "msg.untitledCodexConversation": "未命名 Codex 对话",
  "msg.openAProjectFirst2": "请先打开项目",
  "msg.compilingNameFile": "正在编译 {name} · {file}",
  "msg.compiledPdfEngine": "编译完成：{pdf}（{engine}）",
  "msg.compilationDidNotFinishError": "编译未完成：{error}",
  "msg.opencodeIsStillNotInstalledPleaseInstall":
    "OpenCode 仍未安装，请先安装：\nnpm i -g opencode-ai@latest\n或\nbrew install sst/tap/opencode",
  "msg.opencodeIsNotInstalledPleaseInstallItFir": "OpenCode 未安装，请先用 npm 或 Homebrew 安装。",
  "msg.opencodeStartedSuccessfully": "OpenCode 已启动",
  "msg.pleaseOpenAProjectFirst": "请先打开项目。",
  "msg.failedToStartOpencode": "OpenCode 启动失败",
  "msg.annotationPrompt":
    "请用 Writer MCP 的 writer_get_annotations 读取这些批注，ids={ids}。按每条批注的选文、修改要求和对应 .tex 段落完成修改；先核对当前源码和 sourceChanged。未可靠定位的先按选文查找，仍不确定就向我说明，不能猜测。使用 writer_read_document 获取当前版本，再用 writer_apply_annotation_edit 提交 oldText/newText 替换，不能用 shell/Python 整文件覆盖来绕过合并。sourceChanged 仅提示文稿变化：核对当前段落，可用 writer_reanchor_annotation 更新定位，不要要求我点击行号。无冲突修改自动合并，真正重叠的修改保留为冲突提案，可先处理其他批注。检查引用与 LaTeX，编译验证。完成后用 writer_resolve_annotation，带上 annotationRevision 与已核验的主文件 sourceRevision，标记已处理的批注，并说明改动。当前执行后端：{backend}。",
  "msg.theProjectChangedSoTheAnnotationTaskWasN":
    "项目已切换，批注任务没有派发。请切回原项目重试。",
  "msg.theSelectionDoesNotMatchTheCurrentManusc":
    "选区和当前文稿不一致，请重新选择需要批注的文字。",
  "msg.couldNotStashTheAnnotationDraftSaveBefor": "批注草稿暂存失败，请保存后再关闭应用。",
  "msg.terminalOpenedForGithubLoginCompleteProm":
    "已打开终端进行 GitHub 登录。请在终端中完成提示（询问时输入 Y），然后在浏览器中继续。",
  "msg.githubCliGhIsNotInstalledInstallItFromHt":
    "未安装 GitHub CLI (gh)。请从 https://cli.github.com 安装。",
  "msg.opencodeIsUnavailableInstallItWithNpmIGO":
    "OpenCode 不可用。安装命令：npm i -g opencode-ai@latest",
  "msg.githubAuthenticationIsAlreadyInProgressI": "GitHub 登录已在终端窗口中进行。",
  "msg.couldNotReachOpencodeStartOrRestartTheAg": "无法连接 OpenCode。请启动或重启 Agent 后重试。",
  "msg.stageFilesBeforeGeneratingCommitMessage": "生成提交说明前请先暂存文件。",
  "msg.aiReturnedAnEmptyCommitMessage": "AI 返回的提交说明为空。",
  "msg.noTextualStagedDiffAvailable": "暂存区没有可用的文本差异。",
  "msg.githubAuthenticationFailed": "GitHub 登录失败",
  "msg.repositoryPublishedUrl": "仓库已发布：{url}",
  "msg.failedToCreateRepository": "创建仓库失败",
  "msg.aiCommitDraftGenerated": "已生成 AI 提交说明草稿。",
  "msg.authenticatedWithGithub": "已登录 GitHub",
  "msg.aiDraftFailedError": "AI 草稿生成失败：{error}",
  "msg.changesCommitted": "已提交更改",
  "msg.failedToCommit": "提交失败",
};
export const msgEn: Record<keyof typeof msgZh, string> = {
  "msg.pathMatchesSeveralFilesGiveAPathRelative":
    "“{path}” matches several files; give a path relative to the project: {matches}",
  "msg.listSeparator": ", ",
  "msg.closingWasCancelledBecauseSomeFilesAreNo":
    "Closing was cancelled because some files are not saved. Try again or save a copy. {error}",
  "msg.closeProtectionIsNotActiveError": "Close protection is not active: {error}",
  "msg.couldNotWriteTheLocalRecoveryDraftStorag":
    "Could not write the local recovery draft (storage may be full). Save now or save a copy, and keep the app open.",
  "msg.twoSetsOfEditorChangesConflictMergeThemI":
    "Two sets of editor changes conflict. Merge them in the conflict panel; both drafts were kept.",
  "msg.overlappingChangesWereFoundAndBothVersio":
    "Overlapping changes were found and both versions were kept. Open Conflicts to merge them.",
  "msg.couldNotReadTheLocalRecoveryDraftKeepThe":
    "Could not read the local recovery draft. Keep the app open and save the file.",
  "msg.theFileHasNotBeenReadYetSoItCannotBeSave":
    "The file has not been read yet, so it cannot be saved. Reopen the file.",
  "msg.theEditorChangesConflictOpenTheConflictP":
    "The editor changes conflict. Open the conflict panel.",
  "msg.theFileWasSavedButTheOldRecoveryDraftCou":
    "The file was saved, but the old recovery draft could not be removed.",
  "msg.theDraftChangedAgainReopenTheConflictPan":
    "The draft changed again. Reopen the conflict panel.",
  "msg.savingIsInProgressTryAgainInAMoment": "Saving is in progress. Try again in a moment.",
  "msg.externalChangesWereMergedAutomatically": "External changes were merged automatically",
  "msg.theSelectedTextHasChangedSelectItAgainBe":
    "The selected text has changed. Select it again before sending so the wrong place is not edited.",
  "msg.theProjectChangedSelectTheTextToQuoteAga":
    "The project changed. Select the text to quote again.",
  "msg.savingBeforeDelegationFailedError": "Saving before delegation failed: {error}",
  "msg.theGitAutoSaveCheckFailedError": "The Git auto-save check failed: {error}",
  "msg.couldNotSaveAGitVersionError": "Could not save a Git version: {error}",
  "msg.savedGitVersionHash": "Saved Git version {hash}",
  "msg.noNewChangesTheGitVersionIsUpToDate": "No new changes; the Git version is up to date",
  "msg.untitledOpencodeConversation": "Untitled OpenCode conversation",
  "msg.untitledCodexConversation": "Untitled Codex conversation",
  "msg.openAProjectFirst2": "Open a project first",
  "msg.compilingNameFile": "Compiling {name} · {file}",
  "msg.compiledPdfEngine": "Compiled: {pdf} ({engine})",
  "msg.compilationDidNotFinishError": "Compilation did not finish: {error}",
  "msg.opencodeIsStillNotInstalledPleaseInstall":
    "OpenCode is still not installed. Please install it first:\nnpm i -g opencode-ai@latest\nor\nbrew install sst/tap/opencode",
  "msg.opencodeIsNotInstalledPleaseInstallItFir":
    "OpenCode is not installed. Please install it first using npm or Homebrew.",
  "msg.opencodeStartedSuccessfully": "OpenCode started successfully!",
  "msg.pleaseOpenAProjectFirst": "Please open a project first.",
  "msg.failedToStartOpencode": "Failed to start OpenCode",
  "msg.annotationPrompt":
    "Use the Writer MCP tool writer_get_annotations to read these annotations, ids={ids}. Make the changes each annotation asks for, using its selected text, request and the matching .tex passage; check the current source and sourceChanged first. If an annotation is not reliably located, search for its selected text; if it is still unclear, tell me instead of guessing. Get the current version with writer_read_document, then submit oldText/newText replacements with writer_apply_annotation_edit; do not overwrite whole files with shell or Python to get around merging. sourceChanged only signals that the manuscript changed: check the current passage, and update the location with writer_reanchor_annotation if needed instead of asking me to click line numbers. Non-conflicting edits merge automatically; truly overlapping edits are kept as conflict proposals, and you can handle other annotations first. Check citations and LaTeX, and compile to verify. When done, mark the handled annotations with writer_resolve_annotation, passing annotationRevision and the verified sourceRevision of the main file, and describe the changes. Current backend: {backend}.",
  "msg.theProjectChangedSoTheAnnotationTaskWasN":
    "The project changed, so the annotation task was not sent. Switch back to that project and try again.",
  "msg.theSelectionDoesNotMatchTheCurrentManusc":
    "The selection does not match the current manuscript. Select the text to annotate again.",
  "msg.couldNotStashTheAnnotationDraftSaveBefor":
    "Could not stash the annotation draft. Save before closing the app.",
  "msg.terminalOpenedForGithubLoginCompleteProm":
    "Terminal opened for GitHub login. Complete prompts there (type Y when asked), then continue in browser.",
  "msg.githubCliGhIsNotInstalledInstallItFromHt":
    "GitHub CLI (gh) is not installed. Install it from https://cli.github.com",
  "msg.opencodeIsUnavailableInstallItWithNpmIGO":
    "OpenCode is unavailable. Install it with: npm i -g opencode-ai@latest",
  "msg.githubAuthenticationIsAlreadyInProgressI":
    "GitHub authentication is already in progress in the terminal window.",
  "msg.couldNotReachOpencodeStartOrRestartTheAg":
    "Could not reach OpenCode. Start or restart the Agent and try again.",
  "msg.stageFilesBeforeGeneratingCommitMessage": "Stage files before generating commit message.",
  "msg.aiReturnedAnEmptyCommitMessage": "AI returned an empty commit message.",
  "msg.noTextualStagedDiffAvailable": "No textual staged diff available.",
  "msg.githubAuthenticationFailed": "GitHub authentication failed",
  "msg.repositoryPublishedUrl": "Repository published: {url}",
  "msg.failedToCreateRepository": "Failed to create repository",
  "msg.aiCommitDraftGenerated": "AI commit draft generated.",
  "msg.authenticatedWithGithub": "Authenticated with GitHub",
  "msg.aiDraftFailedError": "AI draft failed: {error}",
  "msg.changesCommitted": "Changes committed",
  "msg.failedToCommit": "Failed to commit",
};
