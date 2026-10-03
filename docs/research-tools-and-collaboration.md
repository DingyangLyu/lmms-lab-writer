# 文献库、修改审阅与多人协作

## 桌面文献库

保存工具栏中的“文献库”扫描当前项目的 `.bib` 与 `.tex`，可按标题、作者、DOI 和引用键搜索，查看引用位置并跳到源码。支持粘贴或导入 BibTeX、从 Crossref 按 DOI 获取元数据、读取本机 Zotero 的本地 API。Zotero 需已启动且启用本地 API；未启用时可用其 BibTeX 导出文件。

导入前有预览；DOI 相同或标准化标题/年份相同的条目默认去重，同名引用键但内容不同会生成新的键。重命名键会同时预览并更新项目内 `.bib` 和 `.tex` 中的引用。字符串宏冲突或不支持的 `@preamble` 需要手动核对，不会静默丢弃。Zotero 的导入是显式拉取、预览后合并，不是后台双向同步；重复条目不会自动覆盖你手工整理的元数据。

保存前后创建本地 Git 版本。跨文件保存会先检查全部原文，过程中再次检查变化；失败时尝试恢复本次已写入内容。遇到外部并发修改不强行覆盖，原文和提案保留在 `.writer/writing-transactions/` 供恢复。尚未提交的表单不等于已写入文献库。

## 桌面修改审阅

“修改审阅”记录新的 Codex、OpenCode 和 Claude Code 任务开始前与完成后的文稿版本；旧任务不会凭空生成历史。支持逐项接受、拒绝和撤销决定，记录关联会话 ID、时间、任务开始时待处理的批注，以及每次审阅决定。

原生 CLI 可以直接修改文件，所以这里是**已经写入后的审阅**：接受表示保留；拒绝会以三方合并撤回该项；撤销决定可重新应用或重新核对。任务期间还可能有人工或其他 Agent 修改，记录明确显示这一归属限制，不把并发的全部修改都认定为某个模型独立完成。真正重叠的改写会进入现有冲突面板，不覆盖后续内容。

记录范围为项目内支持的文稿文本（单文件最多 2 MB、合计 32 MB）；隐藏目录、依赖及构建缓存不扫描，图片与 PDF 在 Git 版本中核对。关闭面板会释放已加载的文稿副本。程序异常结束后，可在任务确实停止后点击“恢复并生成审阅”，从已保存的基线继续核对。

## 多人网页版本

新应用位于 `apps/collaboration`，与介绍网站 `apps/web` 分开。桌面“多人协作”按钮保存当前修改后打开配置的协作地址，不自动上传论文。

已有能力：

- 独立账号、项目、7 天有效的单次邀请；所有者、编辑者、批注者、只读者四种角色。服务端逐次检查权限，移除成员会关闭其活动连接。
- Yjs + CodeMirror 实时共同编辑、协作者光标、仅撤销本人的操作、断线重连与 IndexedDB 本机缓存。服务端 SQLite 持久化成功后才返回保存确认。
- 源码选区批注，使用相对位置锚点；作者、回复线程、已解决/重新打开状态和审计记录。源文字变化或定位失效时会要求重新核对。
- BibTeX 文献库、DOI 查询、导入去重、项目引用键更新。
- **尚未写入的修改建议**：逐项接受、拒绝或撤销。应用时再合并当前正文，避免覆盖合作者后续独立编辑。
- 项目快照、当前文稿恢复、项目 ZIP 导出。恢复前再保存快照，恢复通过协作事务同步，不是强制覆盖其他浏览器的状态。
- 共享 AI/编译任务队列；本机执行器领取快照，AI 文本输出进入审阅，二进制产物放在 `artifacts/<任务 ID>/`，不会覆盖现有图片。原生 CLI 登录凭据留在执行器机器。

网页中的多人批注目前针对源码；桌面 PDF 批注功能仍保留。已有桌面 PDF 批注不会自动变成带多人身份的网页批注。网页上传 PDF 可预览，新的编译产物保留任务版本，尚未提供网页 PDF 的 SyncTeX 批注迁移。

## 本机启动

要求 Node.js 24 和仓库所用 pnpm。

```sh
pnpm install --frozen-lockfile
cp apps/collaboration/.env.example apps/collaboration/.env
# 编辑 apps/collaboration/.env，设置至少 12 位的唯一管理员密码
pnpm --filter @lmms-lab/writer-collaboration build
pnpm --filter @lmms-lab/writer-collaboration start
```

打开 `http://127.0.0.1:8787`，用配置的账号登录。管理员只在空数据库首次启动时创建，修改环境变量不会重置已有账号密码。数据默认在 `apps/collaboration/.data/writer.sqlite`，可通过 `WRITER_DATA_DIR` 指定持久化位置。

本次本机实例使用 `~/Library/Application Support/LMMs-Lab Writer/collaboration/local.env`（仅当前用户可读），数据在其 `data/` 子目录。重新启动这个实例：

```sh
WRITER_ENV_FILE="$HOME/Library/Application Support/LMMs-Lab Writer/collaboration/local.env" \
  pnpm --filter @lmms-lab/writer-collaboration start
```

创建项目后导入完整论文文件夹；隐藏目录、依赖及构建目录跳过。已有同名文件不会被上传操作覆盖。通过“成员”生成邀请链接，合作者设置自己的账号或使用已有账号加入。

## Docker 部署

在仓库根目录创建 `.env`，设置 `WRITER_ADMIN_USER`、`WRITER_ADMIN_PASSWORD`、`WRITER_ORIGIN`。`WRITER_ORIGIN` 必须与浏览器实际地址一致。

```sh
docker compose up -d --build writer
docker compose logs -f writer
```

默认只绑定本机 `127.0.0.1:8787`，数据存于 `writer-data` 命名卷。容器使用非 root 用户、丢弃额外 capabilities，并设定资源限制。不要用 `docker compose down -v` 维护日常服务，否则会删除数据卷。源码可见及商业许可条款适用于本分支，见根目录 LICENSE。

本机服务与 Docker 使用同一默认端口；启动另一种方式前停掉前者，或同时更改 `WRITER_PORT` 与 `WRITER_ORIGIN`。

在线一致性备份使用 SQLite backup API，可在服务运行时执行，不要只复制仍在写入的主数据库文件而漏掉 WAL：

```sh
pnpm --filter @lmms-lab/writer-collaboration backup /path/writer.sqlite /path/backup.sqlite
# Docker 中先写到持久卷，再用 docker cp 复制到另一块磁盘：
docker compose exec writer pnpm --filter @lmms-lab/writer-collaboration backup /data/writer.sqlite /data/backups/backup.sqlite
```

备份目标存在时会拒绝覆盖。恢复整库前先停止服务并另存当前数据库及其 WAL/SHM，再按备份快照恢复；项目内普通误编辑优先用网页的版本恢复，不需要替换整库。

部署到服务器时，在前面配置 HTTPS 反向代理，透传 WebSocket Upgrade，设置公网 HTTPS `WRITER_ORIGIN`。SQLite 版本适合单实例，不能启动多个独立副本共同写同一个数据库文件。需要进一步压测、备份恢复演练和运维监控后再开放给更大范围的用户；目前不作容量或生产 SLA 承诺。

## 共享任务执行器

项目所有者在“任务 → 连接本机执行器”创建项目专属令牌，选定能力。令牌只显示本次，可从服务端撤销。执行器不需要管理员账号密码。

```sh
# 编译镜像一次构建
docker compose --profile tools build tex-image

export WRITER_SERVER=http://127.0.0.1:8787
export WRITER_RUNNER_TOKEN=你的项目执行器令牌
export WRITER_ALLOWED_HARNESSES=compile
pnpm --filter @lmms-lab/writer-collaboration runner
```

编译任务在独立 Docker 容器中执行：无网络、只读系统、单任务目录、非 root、CPU/内存/进程数及时间限制，并关闭 shell escape 和项目 latexmkrc。镜像已包含常用 TeX Live、XeLaTeX/LuaLaTeX 及中文宏包；自定义字体和特殊宏包仍需加入镜像。每次编译产生新的 PDF 产物，失败保留日志与之前 PDF。

可信实验室成员需要共享 AI 任务时，在已有本机 CLI 登录的执行器上显式增加 `codex`、`claude` 或 `opencode` 能力，并使用对应能力的令牌：

```sh
export WRITER_ALLOWED_HARNESSES=codex,claude,opencode
pnpm --filter @lmms-lab/writer-collaboration runner
```

执行器默认沿用对应 CLI 的模型配置；也可设置 `WRITER_CODEX_MODEL`、`WRITER_CLAUDE_MODEL`、`WRITER_OPENCODE_MODEL`。请使用该 CLI 和账号实际支持的模型 ID。若供应商拒绝某个模型，任务会明确失败并保留日志，不会静默切换模型；修改执行器配置后再重新提交。

AI 运行于项目快照的临时目录。Codex 使用 workspace-write 沙盒；Claude 限定文稿读写工具；OpenCode 禁止外部目录及 Bash。不同 CLI 的隔离能力不等同，不应把个人登录的本机 AI 执行器开放给不可信租户。不要把个人 `auth.json` 复制给整个团队。任务失败时执行器保留恢复目录并报告路径；成功提交后清理临时目录。

网页通过事件推送收到状态与结果，用户或发送任务的模型无需循环查询回信。执行器自身通过队列领取任务并续租；取消或撤权会在下一次心跳时停止执行。任务超时或执行器失联不会自动重跑，以免重复修改；可由用户重新提交。

## 验证与当前边界

桌面原生界面已用独立临时项目验收：BibTeX 导入预览与保存、跨 `.tex/.bib` 引用键重命名、Git 检查点、Codex 实际改写后的逐项接受/拒绝/撤销决定。拒绝和撤销决定均保留任务结束后手工添加的独立内容；多人协作入口也已打开本机登录页。

已经覆盖双人中文并发编辑、服务重启恢复、只读拒绝、跨项目访问拒绝、撤权断连、单次邀请、批注回复与状态、独立修改合并、重叠拒绝、任务租约与结果不直接改正文。浏览器实测双向同步、只撤销本人操作、批注同步、离线重连、逐项审阅与 DOI 导入。Docker 实测独立容器编译及服务重启后的数据保留。本机 Codex 执行器也已完成一次真实共享任务：在快照中修改测试文稿，结果进入尚未应用的建议，原共享文稿保持不变。Claude/OpenCode 共享执行器仍需用对应账号做端到端验收。

桌面与网页项目目前通过导入/导出衔接，不对同一个文件夹自动双向同步。网页版本使用数据库快照；桌面仍使用本地 Git 检查点，两者不是同一条 Git 分支。历史快照只恢复所选文稿，批注讨论保留，尚未提供一键回滚整个多人项目及全部讨论状态。大规模同时在线、浏览器缓存配额耗尽、复杂期刊宏包和多节点部署仍需专项验收。
