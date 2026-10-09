# 文献库、修改审阅与多人协作

## 桌面文献库

保存工具栏中的“文献库”扫描当前项目的 `.bib` 与 `.tex`，可按标题、作者、DOI 和引用键搜索，查看引用位置并跳到源码。支持粘贴或导入 BibTeX、从 Crossref 按 DOI 获取元数据、读取本机 Zotero 的本地 API。Zotero 需已启动且启用本地 API；未启用时可用其 BibTeX 导出文件。

导入前有预览；DOI 相同或标准化标题/年份相同的条目默认去重，同名引用键但内容不同会生成新的键。重命名键会同时预览并更新项目内 `.bib` 和 `.tex` 中的引用。字符串宏冲突或不支持的 `@preamble` 需要手动核对，不会静默丢弃。Zotero 的导入是显式拉取、预览后合并，不是后台双向同步；重复条目不会自动覆盖你手工整理的元数据。

保存前后创建本地 Git 版本。跨文件保存会先检查全部原文，过程中再次检查变化；失败时尝试恢复本次已写入内容。遇到外部并发修改不强行覆盖，原文和提案保留在 `.writer/writing-transactions/` 供恢复。尚未提交的表单不等于已写入文献库。

## 桌面修改审阅

“修改审阅”记录新的 Codex、OpenCode 和 Claude Code 任务开始前与完成后的文稿版本；旧任务不会凭空生成历史。支持逐项接受、拒绝和撤销决定，记录关联会话 ID、时间、任务开始时待处理的批注，以及每次审阅决定。

原生 CLI 可以直接修改文件，所以这里是**已经写入后的审阅**：接受表示保留；拒绝会以三方合并撤回该项；撤销决定可重新应用或重新核对。任务期间在编辑器和文献库中的人工保存会合并进该任务的基线，不会被记成 Agent 修改，拒绝某项也不会撤回你的输入；同时运行的其他 Agent 或外部程序的修改仍可能计入，记录明确显示这一归属限制。真正重叠的改写会进入现有冲突面板，不覆盖后续内容。

记录范围为项目内支持的 UTF-8 文稿文本（单文件最多 2 MB、合计 32 MB），超过大小或无法按 UTF-8 读取的文件会跳过；隐藏目录、依赖及构建缓存不扫描，图片与 PDF 在 Git 版本中核对。任务基线保存在不进入 Git 版本的 `.writer/review-baselines/`，生成审阅后删除。记录失败（例如无法创建 Git 版本）不会阻止 Agent 执行，原因显示在“修改审阅”中。关闭面板会释放已加载的文稿副本。程序异常结束后，可在任务确实停止后点击“恢复并生成审阅”，从已保存的基线继续核对。

## 多人网页版本

新应用位于 `apps/collaboration`，独立于桌面应用。桌面“多人协作”按钮保存当前修改后打开配置的协作地址，不自动上传论文。

已有能力：

- 独立账号、项目、7 天有效的单次邀请；所有者、编辑者、批注者、只读者四种角色。服务端逐次检查权限，移除成员会关闭其活动连接。
- 账号管理：每个人可以修改自己的密码（其他设备随之退出登录）。新用户在登录页自行注册，默认需管理员在“管理后台 → 待审核”批准后才能登录；管理员也可以发有效期和次数受限的邀请链接（注册后直接可用），或把注册改为直接可用、关闭。管理后台还能创建账号、重置密码（生成只显示一次的临时密码，对方首次登录必须改掉）、停用或启用、注销账号（历史保留，唯一拥有的项目转给管理员）、授予或取消管理员；系统始终保留至少一名可用的管理员。
- 项目管理：所有者可以改项目名、直接调整成员角色（立即生效，对方编辑器自动重连）、在输入项目名确认后删除项目。项目至少保留一名所有者。
- 项目主页（参照 Overleaf）：左侧“新建项目”菜单可建空白项目、从模板新建或上传 .zip（只含一个文件夹的压缩包会去掉这层文件夹，`.git` 等隐藏文件不导入并列出；文本文件须为 UTF-8）；按“全部 / 我创建的 / 共享给我的 / 已归档 / 回收站”分类，可搜索、按名称、所有者、最后修改时间排序，逐个或批量下载 zip、归档、移到回收站、恢复。归档和回收站只影响自己的列表；回收站里的项目，所有者可输入项目名彻底删除，其他成员可退出项目。任何成员都能复制项目（复制当前文件，不含批注和历史），复制者成为新项目的所有者。
- 模板：内置空白项目、英文期刊论文、中文论文（ctex，XeLaTeX）、Beamer 幻灯片、多章节学位论文和 IEEE 会议论文，位于 `apps/collaboration/templates`。实验室自己的模板放进 `WRITER_TEMPLATES_DIR` 指向的目录即可，每个模板一个文件夹，内含 `template.json`（中英文名称与说明、主文件、编译器、排序）、项目文件和可选的 `preview.png`；与内置模板同名时替换内置模板。
- Yjs + CodeMirror 实时共同编辑、协作者光标、仅撤销本人的操作、断线重连与 IndexedDB 本机缓存。服务端把每次修改追加写入 PostgreSQL 成功后才返回保存确认；同一文档累计约 200 次修改或最后一人离开时自动合并，读取始终包含尚未合并的修改。
- 进入项目后与桌面端同一套工作区（`packages/workbench`）：顶栏切换侧栏、编译日志、PDF、批注栏和 AI 任务，选择主文件与编译器并编译（⌘/Ctrl+S 或 ⌘/Ctrl+Enter）；状态栏显示同步状态、在线成员、批注、文献、审阅；左侧“文件 / 版本”，中间是打开文件的标签页与编辑器，旁边是编译出的 PDF，下方是编译日志，右侧是 AI 任务。手机上侧栏改为浮层。
- 批注（参照 Overleaf）：编辑器右侧的批注栏把每条未解决的批注放在对应正文旁边，随滚动和编辑移动；选中文字后旁边出现“添加批注”。可回复、标为已解决或重新打开，作者可修改和删除自己的批注与回复，所有者可删除任何批注；已解决的批注和原文已被删除的批注在批注栏顶部展开查看。在 PDF 上拖选文字也能批注：SyncTeX 找到源码行，再在这些行里匹配 PDF 的文字（忽略空格、TeX 命令和行尾连字符，匹配不到就锚定整行），批注锚定到源码，同一次编译的 PDF 上画出高亮。批注用 Yjs 相对位置锚定，随协作者的修改移动；状态栏的“批注”列出所有文件的批注并可跳转。正文编辑的审计按“每人每文件每分钟一条”汇总，不逐键记录。
- BibTeX 文献库、DOI 查询、导入去重、项目引用键更新。
- 网页编辑器支持查找替换（Ctrl/Cmd+F）、跳转行、LaTeX 命令与环境补全，`\cite{}` 中补全项目 .bib 的引用键，`\ref{}` 等命令中补全全部 .tex 的标签；文件可在列表中重命名、移动或删除。
- 网页编译与 PDF 预览：点“编译”由服务器用 latexmk 编译（pdfLaTeX／XeLaTeX／LuaLaTeX，含中文宏包时默认 XeLaTeX），右侧显示 PDF、错误和警告列表（点击跳到对应行）与完整日志。双击 PDF 跳到源码，“定位到 PDF”从光标处跳到 PDF 并高亮，跨 `\input` 文件同样可用。每个项目保留最近两次编译结果，合作者打开项目即可看到最新 PDF。
- **尚未写入的修改建议**：逐项接受、拒绝或撤销。应用时再合并当前正文，避免覆盖合作者后续独立编辑。
- 项目快照、版本对比（列出该版本之后新增、删除、改名和修改的文件，文本逐行对比）、当前文稿恢复、项目 ZIP 导出。恢复前再保存快照，恢复通过协作事务同步，不是强制覆盖其他浏览器的状态。手动保存的版本全部保留；删除、导入、审阅决定等操作前的自动版本每个项目保留最近 50 个（排队或执行中任务的输入版本不会被清理），批注本身不再触发整项目快照。删除文件后可在原路径重新创建或上传。
- 共享 AI/编译任务队列；本机执行器领取快照，AI 文本输出进入审阅，二进制产物放在 `artifacts/<任务 ID>/`，不会覆盖现有图片。原生 CLI 登录凭据留在执行器机器。

桌面端打开与服务器关联的文件夹时，状态栏多一个“团队批注”：列出服务器上的同一批批注（回复、解决、编辑、删除，与网页一致），并在编辑器里高亮；本机文字与服务器不同时（还没同步）就先不画，以免标错位置。在这样的文件夹里新写批注时可以选择保存到“团队（服务器）”或“仅本机”：团队批注用本机文字的位置提交，PDF 上的选择先用本机 SyncTeX 定位到源码，服务器核对原文一致后才保存，没同步完会提示稍后再试。仅本机的批注仍保存在 `.writer/`，可以发给 AI 修改；已有的本机批注不会自动上传。

## 本机启动

要求 Node.js 24 和仓库所用 pnpm。

```sh
pnpm install --frozen-lockfile
cp apps/collaboration/.env.example apps/collaboration/.env
# 编辑 apps/collaboration/.env，设置至少 12 位的唯一管理员密码
pnpm --filter @lmms-lab/writer-collaboration build
pnpm --filter @lmms-lab/writer-collaboration start
```

打开 `http://127.0.0.1:8787`，用配置的账号登录。管理员只在空数据库首次启动时创建，修改环境变量不会重置已有账号密码。

数据库为 PostgreSQL，用 `WRITER_DATABASE_URL=postgres://用户:密码@主机:5432/库名` 指定。不设置时使用内嵌的 PGlite（编译为 WebAssembly 的 PostgreSQL），数据在 `WRITER_DATA_DIR/postgres`（默认 `apps/collaboration/.data/postgres`），适合一个人试用；课题组共用请连接独立的 PostgreSQL 服务（下面的 Docker 部署已包含）。启动时自动执行带版本号的结构迁移，旧版本程序遇到更新的数据库结构会拒绝启动。

本次本机实例使用 `~/Library/Application Support/LMMs-Lab Writer/collaboration/local.env`（仅当前用户可读），数据在其 `data/` 子目录。重新启动这个实例：

```sh
WRITER_ENV_FILE="$HOME/Library/Application Support/LMMs-Lab Writer/collaboration/local.env" \
  pnpm --filter @lmms-lab/writer-collaboration start
```

### 从 SQLite 版本迁移

此前版本的数据在 `writer.sqlite`。先停止旧服务，再导入到一个**空的** PostgreSQL 数据库（已有账号的数据库会被拒绝，避免重复导入）：

```sh
WRITER_DATABASE_URL=postgres://writer:密码@127.0.0.1:5432/writer \
  pnpm --filter @lmms-lab/writer-collaboration migrate-sqlite /path/writer.sqlite
```

账号、密码、登录会话、项目、成员、邀请、文件、批注与回复、版本快照、审计、修改建议和执行器令牌全部迁移；迁移时仍在排队或执行的共享任务标为失败，可重新提交。原 SQLite 文件不会被修改，确认无误前请保留。Docker 部署中，旧数据仍在 `writer-data` 卷的 `/data/writer.sqlite`：`docker compose run --rm writer pnpm --filter @lmms-lab/writer-collaboration migrate-sqlite /data/writer.sqlite`。

创建项目后导入完整论文文件夹；隐藏目录、依赖及构建目录跳过。已有同名文件不会被上传操作覆盖。通过“成员”生成邀请链接，合作者设置自己的账号或使用已有账号加入。

### 网页编译的环境与安全

服务器需要 TeX Live（含 latexmk）；Docker 镜像默认已包含常用 TeX Live、XeLaTeX/LuaLaTeX、biber 和中文宏包（构建时加 `--build-arg WRITER_TEX=0` 可得到不含 TeX 的小镜像，此时编译按钮会提示服务器未安装 TeX）。本机运行时使用 PATH 中的 latexmk，或用 `WRITER_LATEXMK` 指定。

每次编译在独立临时目录中进行：关闭 shell escape、忽略项目里的 latexmkrc，TeX 只能读写编译目录（`openin_any=p`、`openout_any=p`），超时（`WRITER_COMPILE_TIMEOUT`，默认 120 秒）后整组进程被终止，同时编译数由 `WRITER_COMPILE_CONCURRENCY`（默认 2）限制，同一项目同一时间只编译一次。编译使用服务器上已同步的正文，正文显示“正在同步保存”时编译按钮会稍等。项目成员（只读者除外）可以编译；所有成员都能查看最新 PDF。

## Docker 部署

在仓库根目录创建 `.env`，设置 `WRITER_ADMIN_USER`、`WRITER_ADMIN_PASSWORD`、`WRITER_ORIGIN` 和数据库密码 `WRITER_POSTGRES_PASSWORD`（只用字母和数字，它会拼进连接地址）。`WRITER_ORIGIN` 必须与浏览器实际地址一致。

```sh
docker compose up -d --build writer
docker compose logs -f writer
```

默认只绑定本机 `127.0.0.1:8787`。PostgreSQL 数据存于 `writer-postgres` 卷，不对外暴露端口；`backup` 服务每天用 `pg_dump` 写一份备份到 `writer-backups` 卷，默认保留 14 天（`WRITER_BACKUP_KEEP_DAYS`）。容器使用非 root 用户、丢弃额外 capabilities，并设定资源限制。不要用 `docker compose down -v` 维护日常服务，否则会删除数据卷。源码可见及商业许可条款适用于本分支，见根目录 LICENSE。

本机服务与 Docker 使用同一默认端口；启动另一种方式前停掉前者，或同时更改 `WRITER_PORT` 与 `WRITER_ORIGIN`。

立即备份或复制到另一台机器：

```sh
docker compose exec postgres pg_dump -U writer -Fc writer > writer-$(date +%Y%m%d).dump
docker compose cp backup:/backups ./writer-backups   # 取出自动备份
```

恢复前先停止 `writer`，再恢复到数据库（会覆盖同名对象）：

```sh
docker compose stop writer
docker compose exec -T postgres pg_restore -U writer -d writer --clean --if-exists < writer-20261007.dump
docker compose start writer
```

项目内普通误编辑优先用网页的版本恢复，不需要恢复整库。定期把备份复制到另一块磁盘，并演练一次恢复。

部署到服务器时，在前面配置 HTTPS 反向代理，透传 WebSocket Upgrade，设置公网 HTTPS `WRITER_ORIGIN`。实时协作的文档状态在服务进程内存中协调，目前只能运行一个 `writer` 实例（数据库可以独立部署和备份）。需要进一步压测、备份恢复演练和运维监控后再开放给更大范围的用户；目前不作容量或生产 SLA 承诺。

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

网页通过事件推送收到状态与结果，用户或发送任务的模型无需循环查询回信。执行器自身通过队列领取任务并续租；取消或撤权会在下一次心跳时停止执行。提交者已失去编辑权限的排队任务会标记为失败并跳过，不阻塞后续任务。任务期间被合作者重命名的文件，AI 输出仍按原文件生成建议。任务超时或执行器失联不会自动重跑，以免重复修改；可由用户重新提交。

## 验证与当前边界

桌面原生界面已用独立临时项目验收：BibTeX 导入预览与保存、跨 `.tex/.bib` 引用键重命名、Git 检查点、Codex 实际改写后的逐项接受/拒绝/撤销决定。拒绝和撤销决定均保留任务结束后手工添加的独立内容；多人协作入口也已打开本机登录页。

已经覆盖双人中文并发编辑、服务重启恢复、只读拒绝、跨项目访问拒绝、撤权断连、单次邀请、批注回复与状态、独立修改合并、重叠拒绝、任务租约与结果不直接改正文。浏览器实测双向同步、只撤销本人操作、批注同步、离线重连、逐项审阅与 DOI 导入。Docker 实测独立容器编译及服务重启后的数据保留。本机 Codex 执行器也已完成一次真实共享任务：在快照中修改测试文稿，结果进入尚未应用的建议，原共享文稿保持不变。Claude/OpenCode 共享执行器仍需用对应账号做端到端验收。

桌面与网页项目目前通过导入/导出衔接，不对同一个文件夹自动双向同步。网页版本使用数据库快照；桌面仍使用本地 Git 检查点，两者不是同一条 Git 分支。历史快照只恢复所选文稿，批注讨论保留，尚未提供一键回滚整个多人项目及全部讨论状态。大规模同时在线、浏览器缓存配额耗尽、复杂期刊宏包和多节点部署仍需专项验收。
