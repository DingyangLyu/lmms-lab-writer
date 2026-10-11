export const editorZh = {
  "editor.label": "多人 LaTeX 编辑器",
  "editor.tooLarge": "文稿超过 2 MB，请拆分文件；本次输入未覆盖原文。",
  "editor.anchorLost": "批注原文已删除，需要重新定位",
  "sync.draftUnavailable": "本机离线草稿保存不可用：{error}",
  "sync.denied": "权限已改变，本机未同步文字仍保留，可导出恢复副本；不会覆盖服务器。",
  "sync.badData": "同步数据错误：{error}",
  "sync.signedOut": "连接权限失效，请重新登录；本机草稿保留。",
  "project.roleChanged": "项目权限已变更，请返回项目列表重新进入。",
  "preview.download": "下载 {path}",
  "preview.external": "此文件可下载后用本机应用打开。",
};
export const editorEn: Record<keyof typeof editorZh, string> = {
  "editor.label": "Shared LaTeX editor",
  "editor.tooLarge":
    "The document would exceed 2 MB; split it into files. This input was not applied.",
  "editor.anchorLost": "The commented text was deleted; the comment needs a new position",
  "sync.draftUnavailable": "Offline drafts cannot be saved on this device: {error}",
  "sync.denied":
    "Your permissions changed. Unsynced text stays on this device and can be exported; the server is not overwritten.",
  "sync.badData": "Sync data error: {error}",
  "sync.signedOut": "Your connection is no longer authorized; sign in again. Local draft kept.",
  "project.roleChanged": "Your access to this project changed; return to the project list.",
  "preview.download": "Download {path}",
  "preview.external": "Download this file to open it with an app on your computer.",
};
