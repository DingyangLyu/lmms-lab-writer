/**
 * English wording of the server's messages, keyed by the Chinese template passed to `fail`
 * (or used as a close reason). Clients choose English with `X-Writer-Locale: en`, or
 * `?locale=en` on a WebSocket; anything missing here is sent in Chinese.
 */
import { format, type Locale, type Params } from "@lmms-lab/i18n";

export const englishMessages: Record<string, string> = {
  // app, auth, http
  无效路径: "Invalid path",
  "资源不存在，请先运行 pnpm build": "Not found; run pnpm build first",
  请求来源不匹配: "Request origin does not match",
  请先修改管理员给你的临时密码: "Change the temporary password from your administrator first",
  // registration and account administration
  该用户不在待审核状态: "This account is not waiting for approval",
  不能注销自己的账号: "You cannot delete your own account",
  "该用户是 {count} 个项目的唯一所有者，确认后这些项目会转给你":
    "This account is the only owner of {count} {count|project|projects}; once you confirm, they pass to you",
  "有效期需为 1–90 天": "Validity must be 1\u201390 days",
  "可用次数需为 1–100 次": "Uses must be 1\u2013100",
  无效的注册方式: "Invalid registration setting",
  账号已注销: "The account has been deleted",
  账号正在等待管理员审核: "The account is waiting for an administrator's approval",
  "暂不开放注册，请联系管理员获取邀请":
    "Registration is closed; ask an administrator for an invitation",
  接口不存在: "No such endpoint",
  "密码需要 12–200 个字符": "Passwords need 12–200 characters",
  请登录: "Please sign in",
  登录已过期: "Your sign-in has expired",
  无效角色: "Invalid role",
  "请求超过 {size}": "The request exceeds {size}",
  上传未完成: "The upload did not finish",
  "无效 JSON": "Invalid JSON",
  "请求必须为 JSON 对象": "The request body must be a JSON object",
  "无效字段 {key}": "Invalid field {key}",
  输入无效: "Invalid input",
  "服务操作失败，数据仍保留；请检查服务日志":
    "The server could not complete this; your data is kept. Check the server log.",
  无效文件路径: "Invalid file path",
  // collaboration sockets
  光标数量超限: "Too many cursors",
  二进制文件不支持共同编辑: "Binary files cannot be edited together",
  "Origin 不匹配": "Origin does not match",
  连接不存在: "No such connection",
  请先修改临时密码: "Change your temporary password first",
  同步连接不指定文件: "A sync connection does not name a file",
  同时连接数量达到上限: "Too many simultaneous connections",
  文档不存在: "Document not found",
  无效光标信息: "Invalid cursor data",
  不能修改其他人的光标: "You cannot change someone else's cursor",
  未知消息: "Unknown message",
  无效文档: "Invalid document",
  同步的文档数量达到上限: "Too many documents are being synced",
  无效状态向量: "Invalid state vector",
  请先加入文档: "Join the document first",
  无效更新: "Invalid update",
  文档超过限制: "The document exceeds the size limit",
  "文档历史过大，请创建新文档快照": "The document history is too large; create a new snapshot",
  "文档已有新的修改，请刷新审阅": "The document has changed; refresh the review",
  "文档超过 2 MB": "The document exceeds 2 MB",
  "修改过大，请拆分后审阅": "The change is too large; split it before review",
  文档历史过大: "The document history is too large",
  登录或项目权限已失效: "Your sign-in or project access is no longer valid",
  项目权限已变更: "Your project access changed",
  权限已更新: "Permissions updated",
  同步失败: "Sync failed",
  文档不可用: "Document unavailable",
  // builds
  "请选择 .tex 主文件": "Choose a main .tex file",
  不支持的编译器: "Unsupported engine",
  "这个项目正在编译，请稍候": "This project is already compiling; please wait",
  "服务器没有安装 TeX（latexmk），请管理员安装 TeX Live 或使用含 TeX 的镜像":
    "TeX (latexmk) is not installed on the server; ask an administrator to install TeX Live or use the image with TeX",
  "没有这个编译结果的 PDF": "This build has no PDF",
  "编译结果已过期，请重新编译": "This build has expired; compile again",
  "这次编译没有 SyncTeX 数据": "This build has no SyncTeX data",
  "项目中没有 {main}": "{main} is not in the project",
  "在编译结果中找不到对应位置，请重新编译": "No matching position in this build; compile again",
  "无效参数 {name}": "Invalid parameter {name}",
  // accounts and sessions
  需要管理员权限: "Administrator rights required",
  用户不存在: "No such user",
  请填写当前密码和新密码: "Enter your current and new passwords",
  当前密码不正确: "The current password is wrong",
  新密码不能与当前密码相同: "The new password must differ from the current one",
  "用户名需 2–80 个字符，只能含文字、数字、空格和 _ . -":
    "Usernames need 2–80 characters: letters, digits, spaces and _ . -",
  用户名已存在: "That username is taken",
  不能取消自己的管理员权限或停用自己:
    "You cannot remove your own administrator rights or disable yourself",
  至少需要保留一名可用的管理员: "At least one active administrator must remain",
  "密码已修改，请重新登录": "Password changed; sign in again",
  管理员已重置密码: "An administrator reset the password",
  账号已停用: "Account disabled",
  "登录尝试过多，请稍后重试": "Too many sign-in attempts; try again later",
  用户名或密码错误: "Wrong username or password",
  "账号已停用，请联系管理员": "This account is disabled; contact an administrator",
  请先在网页上修改管理员给你的临时密码:
    "Change the temporary password from your administrator on the web page first",
  用户名格式无效: "Invalid username",
  邀请已失效: "This invitation has expired",
  "该用户名已存在，请使用原密码": "That username exists; use its password",
  邀请已使用: "This invitation was already used",
  "该用户名刚被注册，请换一个": "That username was just taken; choose another",
  当前不是设备登录: "This is not a device sign-in",
  已退出登录: "Signed out",
  // bibliography
  "Crossref 未找到这个 DOI": "Crossref does not know this DOI",
  元数据过大: "The metadata is too large",
  "请选择 BibTeX 文件": "Choose a BibTeX file",
  文献库已有新的修改: "The bibliography has changed meanwhile",
  // comments
  批注不存在: "Comment not found",
  请选择源码段落批注: "Select source text to comment on",
  "选区已失效，请重新选择": "The selection is no longer valid; select again",
  "选文已被修改，请核对后重新批注": "The selected text changed; check it and comment again",
  批注不能为空: "The comment is empty",
  回复不能为空: "The reply is empty",
  只有作者或编辑者可以更改批注状态: "Only the author or an editor can change a comment's status",
  // files
  无效文件编码: "Invalid file encoding",
  "单文件超过 10 MB": "The file exceeds 10 MB",
  "单个文件超过 {size}": "A file exceeds {size}",
  "{path} 超过 {size}": "{path} exceeds {size}",
  "文件已被其他人更新，请先同步": "Someone else updated the file; sync first",
  "文本文件超过 2 MB": "The text file exceeds 2 MB",
  "项目超过 {count} 个文件或 {size}": "The project exceeds {count} files or {size}",
  "同名文件已存在，请在编辑器中更新": "A file with that name exists; update it in the editor",
  "重命名不能改变文本／二进制文件类型，请上传为新文件":
    "Renaming cannot turn a text file into a binary one or back; upload a new file",
  目标路径已有文件: "A file already exists at that path",
  文件已删除: "The file was deleted",
  // history
  版本不存在: "Version not found",
  该版本不含此文档: "This version does not contain the document",
  二进制文件不能逐行对比: "Binary files cannot be compared line by line",
  只支持恢复文本: "Only text can be restored",
  项目快照过大: "The project snapshot is too large",
  // jobs and runners
  "Runner 凭据无效": "Invalid runner credentials",
  // live AI conversations (agents.ts)
  "共享执行器未连接，AI 对话暂不可用":
    "The shared runner is not connected; AI conversations are unavailable",
  共享执行器已断开: "The shared runner disconnected",
  执行器没有响应: "The runner did not respond",
  "执行器：{error}": "Runner: {error}",
  "AI 对话操作失败": "The AI conversation request failed",
  无效对话: "Invalid conversation",
  "修订太多，请先接受或拒绝一些修订再继续修改":
    "There are too many tracked changes; accept or reject some before editing further",
  对话不存在或未共享: "This conversation does not exist or is not shared with you",
  没有这个安装包: "There is no such installer",
  "只有正在运行的对话可以使用 Writer 工具":
    "Only the conversation whose turn is running can use the Writer tools",
  不能把任务交给自己: "A conversation cannot hand a task to itself",
  "执行器没有提供 {harness}": "The runner does not offer {harness}",
  委派来的任务不能再委派: "A handed-on task cannot be handed on again",
  "这是从其他项目关联来的对话，只能查看；请回到原项目继续":
    "This conversation is shown here from another project and is read-only; continue it in its own project",
  请先把对话共享给项目成员: "Share the conversation with the project's members first",
  只有对话的发起人可以重命名或共享:
    "Only the member who started this conversation can rename or share it",
  "对话名称需为 1–120 个字符": "Conversation names must be 1\u2013120 characters",
  执行器不支持这种权限模式: "The runner does not support this permission mode",
  这个对话还在运行: "This conversation is still running",
  "{name} 的 AI 对话正在修改此项目，请等它完成":
    "{name}'s AI conversation is changing this project; wait until it finishes",
  这一轮已经结束: "This turn has already ended",
  消息不能为空: "The message is empty",
  "一次最多发送 6 张图片": "Send at most 6 images at a time",
  图片格式或大小不正确: "Wrong image format or size",
  "图片总大小超过 24 MB": "The images exceed 24 MB in total",
  "AI 改动无效": "Invalid AI changes",
  "文件已被其他人修改，未删除": "Someone else changed the file; it was not deleted",
  文件类型已改变: "The file changed between text and binary",
  文件已被其他人替换: "Someone else replaced the file",
  任务不存在: "Task not found",
  任务已结束或取消: "The task already finished or was cancelled",
  提交者已无编辑权限: "The submitter can no longer edit",
  任务输出文件无效: "Invalid task output files",
  任务快照不存在: "The task snapshot no longer exists",
  无效输出: "Invalid output",
  输出超过限制: "The output exceeds the limits",
  输出路径重复: "Duplicate output path",
  产物路径过长: "Output path too long",
  不能用文本覆盖二进制文件: "Text cannot replace a binary file",
  请选择执行器能力: "Choose what the runner may do",
  不支持的执行环境: "Unsupported runner",
  "请选择 .tex 入口": "Choose the main .tex file",
  "本项目最多 10 个排队/执行中的任务": "A project can have at most 10 queued or running tasks",
  "项目超过 {count} 个文件或 {size}，产物未保存":
    "The project would exceed {count} files or {size}; the output was not saved",
  // projects and proposals
  请填写项目名: "Enter a project name",
  回复不存在: "Reply not found",
  "无效的 PDF 选区坐标": "Invalid PDF selection coordinates",
  只有作者可以修改批注内容: "Only the author can change this comment",
  只有作者或所有者可以删除批注: "Only the author or an owner can delete this comment",
  只有作者可以修改回复: "Only the author can change this reply",
  只有作者或所有者可以删除回复: "Only the author or an owner can delete this reply",
  "{path} 不是 UTF-8 编码，请转换后再上传": "{path} is not UTF-8 text; convert it and upload again",
  压缩包中有重复的文件路径: "The zip contains the same path twice",
  "压缩包超过 {size}": "The zip exceeds {size}",
  // people
  没有头像: "No profile picture",
  "头像图片超过 {size}": "The picture exceeds {size}",
  "头像须为 PNG、JPEG 或 WebP 图片": "The picture must be a PNG, JPEG or WebP image",
  不能添加自己为好友: "You cannot add yourself as a friend",
  你们已经是好友: "You are friends already",
  好友申请不存在: "There is no such friend request",
  "只能直接添加好友，其他人请发送邀请链接":
    "Only friends can be added directly; send others an invitation link",
  对方已经是项目成员: "They are a member of the project already",
  // templates
  没有这个预览: "There is no such preview",
  请填写模板名称: "Enter a name for the template",
  模板所在的磁盘暂时不可用: "The disk that holds the templates is not available right now",
  内置模板不能修改: "Built-in templates cannot be changed",
  只有模板的发布者或管理员可以修改:
    "Only whoever published the template or an administrator can change it",
  服务器没有配置模板库: "The server has no template library configured",
  "模板最多 {count} 个文件、100 MB": "A template can have at most {count} files and 100 MB",
  "无法读取压缩包，请上传 .zip 文件": "The upload could not be read; upload a .zip file",
  压缩包里没有可用的文件: "The zip has no files that can be used",
  模板不存在: "No such template",
  项目不存在: "Project not found",
  请输入完整项目名确认删除: "Type the full project name to confirm deletion",
  成员不存在: "Member not found",
  项目至少需要一名所有者: "A project needs at least one owner",
  不能撤销自己的所有者权限: "You cannot remove your own owner rights",
  邀请不能授予所有者角色: "Invitations cannot grant the owner role",
  项目已被删除: "The project was deleted",
  暂不支持二进制补丁: "Binary changes cannot be proposed",
  建议不存在: "Suggestion not found",
  建议已被其他人更新: "Someone else updated this suggestion",
  修改项不存在: "Change not found",
  无效决定: "Invalid decision",
  "这处内容已有重叠修改；建议保留，请核对最新正文后重新提交":
    "This passage has an overlapping edit; the suggestion is kept. Check the latest text and submit again.",
  // store
  无权访问此项目: "You do not have access to this project",
  当前角色不允许此操作: "Your role does not allow this",
};

/** A message (template plus parameters) in the requested language. */
export function say(locale: Locale, template: string, params?: Params) {
  return format(locale === "en" ? (englishMessages[template] ?? template) : template, params);
}

/** `X-Writer-Locale` from the web and desktop clients, else the browser's language. */
export function requestLocale(headers: Record<string, string | string[] | undefined>): Locale {
  const chosen = headers["x-writer-locale"];
  if (chosen === "en" || chosen === "zh") return chosen;
  const accepted = String(headers["accept-language"] ?? "")
    .split(",")[0]
    ?.trim()
    .toLowerCase();
  return accepted?.startsWith("en") ? "en" : "zh";
}
