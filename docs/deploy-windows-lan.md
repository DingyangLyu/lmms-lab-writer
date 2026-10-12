# 在实验室 Windows 电脑上部署（内网，不用 Docker）

实验室工作站 DESKTOP-0L24B21 用的就是这种方式：协作服务直接用 Node 跑在 Windows 上，数据放在本机 PostgreSQL，组员在校园网里打开 `http://<这台电脑的 IP>`。同一台电脑上的 Codex 作为“共享执行器”，为所有项目提供网页右侧的 AI 对话（与桌面端同一个面板）。需要公网访问时，再按 [deploy-windows.md](deploy-windows.md) 加 HTTPS 或经一台公网服务器转发。

```
组员浏览器 / 桌面端 ──HTTP :80──▶ node（Writer Server）──▶ PostgreSQL（本机）
                                   ▲              └──▶ TeX Live（PDF 预览编译）
                 Writer Runner ────┘  Codex / OpenCode（这台电脑登录的账号）
```

## 目录和后台任务

程序和数据都在内置 NVMe 固态盘 C: 上。D:、F: 是 USB 机械移动硬盘，E: 是 USB 固态移动硬盘：USB 盘的写缓存不保证数据库提交真正落盘，拔出、休眠或掉线都会让服务出错，所以只用 D: 存放备份。（2026 年 10 月从 D: 迁到 C:，旧目录暂留为 `D:\writer.old`、`D:\texlive.old`；网络代理 mihomo 同时从 `D:\net` 迁到 `C:\net`，旧目录为 `D:\net.old`。）

| 位置 | 内容 |
| --- | --- |
| `C:\writer\app` | 本仓库（`git pull` 更新） |
| `C:\writer\config\server.env` | 服务端配置：监听地址、`WRITER_ORIGIN`、数据库 URL、共享执行器令牌 |
| `C:\writer\config\runner.env` | 执行器配置：只有执行器令牌、Codex/OpenCode 路径和代理 |
| `C:\writer\config\secrets.json` | 首次生成的密码和令牌（数据库、管理员初始密码、执行器） |
| `C:\writer\pgsql`、`C:\writer\pgdata` | PostgreSQL 17 程序和数据（服务 `postgresql-writer`，只监听 127.0.0.1） |
| `C:\texlive\current` | TeX Live（服务端编译 PDF 用的 latexmk） |
| `C:\writer\logs` | `server.log`、`runner.log`、`backup.log` |
| `D:\writer-backups` | 每 6 小时的数据库备份，保留 14 天（D: 没接上时写到 `C:\writer\backups`）；每份同时复制到北京服务器，见下文“备份、监控和提醒” |
| `E:\writer-data\templates` | 模板库：官方会议/期刊模板和组员发布的模板，每个模板一个文件夹（`files/` 项目文件、`preview/` 预览图和示例 PDF）；`.cache` 是下载的官方作者包 |
| `%USERPROFILE%\.writer-runner\projects` | AI 对话的项目工作副本（每个项目一份；可以删除，每轮开始前会从服务器重新同步） |
| `%USERPROFILE%\.writer-runner\claude-sessions`、`opencode.pid` | Claude Code 对话记录；执行器启动的 `opencode serve` 的进程号（执行器重启时用来结束上一个） |

任务计划程序里 `\Writer\` 下的三个任务都以 yuanbai 身份、“不管用户是否登录都运行”：

- **Writer Server**：开机启动 `run-writer.ps1 -Name server`，进程退出 5 秒后自动重启。
- **Writer Runner**：开机启动 `run-writer.ps1 -Name runner`，以最高权限运行。
- **Writer Backup**：每天 0、6、12、18 点运行 `backup-writer.ps1`（仓库里的 `deploy/lab/backup-writer.ps1`）。

`config` 下的文件只有 yuanbai 和 SYSTEM 能读。

## 首次搭建要点

1. Node LTS：`winget install OpenJS.NodeJS.LTS`，再 `npm.cmd install -g pnpm @openai/codex opencode-ai`。这台电脑的 PowerShell 执行策略是 `Restricted`，`.ps1` 脚本不能运行，所以这里一律用 `.cmd` 版本：`npm` 全局目录和 `C:\Program Files\nodejs` 里有 `.cmd` 同名文件的 `.ps1` 包装脚本已改名为 `*.ps1.disabled`，直接输入 `pnpm`、`npm`、`npx`、`codex`、`opencode` 也会走 `.cmd`。`npm.cmd install -g` 或升级 Node 后可能重新生成 `.ps1`，再改名即可；本文仍写 `pnpm.cmd` 等，两种情况都能用。
2. PostgreSQL：这台电脑上 EnterpriseDB 安装器写不了临时 `.bat` 文件，所以用官方免安装包：解压到 `C:\writer\pgsql`，`initdb -D C:\writer\pgdata -U postgres -A scram-sha-256 -E UTF8 --locale=C`，给 `NT AUTHORITY\NetworkService` 授予数据目录权限，`pg_ctl register -N postgresql-writer -S auto -U "NT AUTHORITY\NetworkService"`，再建 `writer` 用户和数据库。
3. TeX Live：从清华镜像下载 `install-tl.zip`，用 profile 安装 `scheme-full`（不装文档和源码）到 `C:\texlive\current`。整个目录可以原样搬到别的盘，之后只需把 `texmf-var\fonts\conf\fonts.conf` 里的绝对路径改掉并运行 `fc-cache -fs`。
4. 代码：`pnpm.cmd install --frozen-lockfile --filter "@lmms-lab/writer-collaboration..."`，`pnpm.cmd --filter @lmms-lab/writer-collaboration build`。
5. `server.env`：`WRITER_HOST=0.0.0.0`、`WRITER_PORT=80`、`WRITER_ORIGIN=http://<IP>`（可用逗号写多个地址，第一个用于邀请链接；用 IP 打开网页时，浏览器访问的那个地址本身也被认可，所以有线、Wi-Fi 两个地址都能登录）、`WRITER_DATABASE_URL`、`WRITER_ADMIN_USER/PASSWORD`（只在数据库还没有用户时创建管理员）、`WRITER_SHARED_RUNNER_TOKEN`（`openssl rand -hex 32` 形式的 64 位十六进制）及其名称和能力（`codex,opencode`）。`WRITER_TEMPLATE_LIBRARY=E:\writer-data\templates`（模板库，放在 USB 固态盘 E: 上，节省 C: 空间；E: 暂时不可用时网页只显示内置模板）。可选 `WRITER_TEMPLATES_DIR=C:\writer\templates` 再加一个只读的实验室模板目录。`WRITER_DOWNLOADS_DIR=E:\writer-data\downloads`：网页“桌面端”页提供下载的安装包。发布新版本时，把 GitHub Release 里的 `.pkg`、`.dmg`、`-setup.exe`、`.msi`、`.AppImage`、`.deb`、`.rpm` 放进这个目录（先删掉旧版本），不需要重启服务。
6. `runner.env`：`WRITER_SERVER=http://127.0.0.1`、`WRITER_RUNNER_TOKEN`（同上）、`WRITER_ALLOWED_HARNESSES`、`WRITER_CODEX_BIN`/`WRITER_OPENCODE_BIN`（指向 npm 包里的 `codex.exe`、`opencode.exe`，避开 `.cmd`）、`WRITER_CODEX_SANDBOX=danger-full-access`、`HTTPS_PROXY`/`HTTP_PROXY`（本机代理）和 `NO_PROXY=127.0.0.1,localhost,::1`。
7. 防火墙：只放行校园网访问 80 端口，例如 `New-NetFirewallRule -Name Writer-HTTP-LAN -Direction Inbound -Protocol TCP -LocalPort 80 -RemoteAddress 10.100.0.0/16 -Action Allow`。
8. 接电源时不睡眠：`powercfg /change standby-timeout-ac 0`、`powercfg /change hibernate-timeout-ac 0`；硬盘 20 分钟无访问才停转（`powercfg /change disk-timeout-ac 20`，原来是 30 秒，USB 机械盘会频繁起停），并关闭 USB 选择性暂停。

## AI 执行器

- Codex 用这台电脑上 `~/.codex` 的登录（与 Codex 桌面版共用，不要复制 `auth.json`，ChatGPT 登录的刷新令牌会轮换，副本会互相作废）；OpenCode 用 `~/.local/share/opencode/auth.json` 和 `~/.config/opencode/opencode.json`。所有 AI 任务都消耗这个账号的额度。
- Codex 在 Windows 的后台任务里无法使用自身沙箱，所以设为 `danger-full-access`：组员的提示词能以 yuanbai 的权限访问这台电脑上的文件（包括上面的凭据）。只给信任的组员编辑权限。执行器不会把 `WRITER_*` 令牌、密码和数据库 URL 交给 AI。
- 访问 OpenAI 需要本机代理（mihomo，见下文“网络”）可用；代理不通时 Codex 对话会报错，OpenCode 用的国内模型不受影响。
- 网页 AI 对话：Writer Runner 启用了 `codex`、`claude` 或 `opencode` 能力时，会再连一条 WebSocket 到服务器（`/api/runner/agents`，同一个共享执行器令牌）。网页显示执行器启用、且服务器 `WRITER_SHARED_RUNNER_HARNESSES` 也列出的那些（按 Codex、Claude Code、OpenCode 排）。一个 `codex app-server` 和一个 `opencode serve`（只监听 127.0.0.1 的随机端口）服务所有项目，Claude Code 每轮启动一次 CLI。每个项目在 `%USERPROFILE%\.writer-runner\projects\<项目 ID>` 有一份工作副本，每轮开始前和服务器同步；AI 每改完一步，改动就合并进共享正文（以发起这一轮的成员名义），与他人同时改到同一处的部分转为待审阅建议。每轮开始前服务器自动保存一个版本“AI 对话修改前”，可在“版本”里恢复。
- 只有项目的所有者和编辑者能用 AI 对话；新对话默认共享给项目的所有者和编辑者，发起人可在对话标题旁或“历史对话”里设为私有。同一项目同时只运行一轮。
- 因为 `WRITER_CODEX_SANDBOX=danger-full-access`，网页上 Codex 的权限只提供“完全访问”；其他机器可用 `WRITER_CODEX_PERMISSIONS=readOnly,askForApproval,autoReview,fullAccess` 指定。Claude Code 的四种权限都提供，可用 `WRITER_CLAUDE_PERMISSIONS` 限制。OpenCode 在网页上默认不能运行 shell、不能访问项目以外的文件夹，可改 `WRITER_OPENCODE_PERMISSION`（OpenCode 的权限 JSON）。浏览器拿不到 OpenCode 的配置原文和供应商密钥：执行器只转发模型和智能体名称。
- 要在网页上用 Claude Code：在这台电脑装好 Claude Code 并 `claude auth login`，`runner.env` 设 `WRITER_CLAUDE_BIN`（指向 `claude.exe`），并把 `claude` 加进 `WRITER_ALLOWED_HARNESSES` 和 `server.env` 的 `WRITER_SHARED_RUNNER_HARNESSES`。
- 工作副本位置可用 `WRITER_AGENT_WORKSPACES` 改；`WRITER_AGENT_HOST=0` 关闭网页 AI 对话。
- 更新代码后要同时重启 Writer Server 和 Writer Runner（见下），网页 AI 对话才会用上新版本。

## 模板库

网页“模板库”里的官方模板来自各会议和期刊的作者包，清单在仓库的 `apps/collaboration/template-library/sources.json`（下载地址、哪一层文件夹是项目、去掉哪些文件、主文件、简介）。会议发布新一年的模板后，改清单里的地址和年份，然后在这台电脑上重新构建：

```powershell
cd C:\writer\app\apps\collaboration
$env:WRITER_LATEXMK = "C:\texlive\current\bin\windows\latexmk.exe"
node node_modules\tsx\dist\cli.mjs server\template-build.ts --out E:\writer-data\templates                      # 全部
node node_modules\tsx\dist\cli.mjs server\template-build.ts --out E:\writer-data\templates --only neurips-2026
```

脚本把作者包下载到 `E:\writer-data\templates\.cache`，整理成模板，用 latexmk 编译示例 PDF，再用 TeX Live 自带的 Ghostscript（`rungs.exe`）渲染前 4 页预览和缩略图；新模板完整生成后才替换旧的。AAAI 的下载页有人机验证，脚本拿不到时会提示，把 zip 手动放进 `.cache`（文件名见清单的 `archive`）再运行即可。网页最多 30 秒后显示更新。

组员发布的模板同样在这个目录（`template.json` 里 `official: false`），每次随数据库备份一起镜像到 `D:\writer-backups\templates`。

## 账号和注册

默认“注册后需管理员审核”：组员在登录页注册，管理员在“管理后台 → 待审核”批准后才能登录。管理后台还可以：

- 生成邀请链接（有效期、可用次数），拿到链接的人注册后直接可用；
- 改为“注册后直接可用”或“关闭注册”；
- 注销账号：历史评论和版本保留，账号名释放，对方唯一拥有的项目转给执行注销的管理员。

项目所有者发出的项目邀请，如果对方是新用户，账号同样要管理员审核（管理员自己发的项目邀请除外）。

## 网络（洛杉矶线路）

这台电脑不再用 FlClash 的机场订阅，而是用 mihomo（FlClash 的同一内核）作为系统服务，不登录也在运行：

- 程序和配置：`C:\net\mihomo`（`config.yaml` 只有 SYSTEM、管理员和 yuanbai 能读；`C:\net` 的脚本以 SYSTEM 运行，所以整个目录只有这三者能改），日志 `C:\net\logs`；
- 任务计划程序 `\Network\Mihomo`（开机启动，退出后自动重启）和 `\Network\Mihomo Watchdog`（每 5 分钟经代理测试一次，连续 3 次失败且直连正常时重启 mihomo；整个网络断开时只记日志）；
- 境外流量走洛杉矶服务器（出口 IP 固定）；国内网站（GeoSite/GeoIP 中国列表）、B 站、ToDesk、百度网盘、微信、QQ、钉钉、飞书、Windows 更新等直连；局域网地址不进 TUN；
- 本机代理端口仍是 `127.0.0.1:7890`，Writer 执行器经它访问 OpenAI；
- 需要再加直连的网站或程序：在 `config.yaml` 的 `rules` 里 `GEOSITE,cn,DIRECT` 之前加 `DOMAIN-SUFFIX,<域名>,DIRECT` 或 `PROCESS-NAME,<程序>.exe,DIRECT`，用 `C:\net\mihomo\mihomo.exe -t -d C:\net\mihomo` 检查后重启 Mihomo 任务；
- 这台电脑接了网线（以太网，10.100.144.0/20 网段，目前 10.100.147.57）和 Wi-Fi（BJZGCA-Dorm，10.100.128.0/20，目前 10.100.131.101），两个地址都由 DHCP 分配。网线是首选出口（接口跃点 以太网 10、WLAN 35），Wi-Fi 连着时作为备用。有线网刚接上时曾对 HTTPS 做中间人拦截（连洛杉矶节点拿到伪造的证书），处理好之后恢复正常；代理日志再出现 `certificate signed by unknown authority`，先用浏览器在这台电脑上确认有线网是否需要重新认证，必要时把以太网跃点调到 75 临时改走 Wi-Fi；
- FlClash 仍安装着（打开它会把辅助服务重新装成自动启动，单独运行的辅助服务不影响网络）；不要在 FlClash 里打开 TUN 或系统代理，否则会和 mihomo 抢路由和 7890 端口。

## 备份、监控和提醒

脚本和配置都在仓库的 `deploy/lab/`（`backup-writer.ps1`；`writer-monitor.py` 和 `monitor-config.*.json`；`nginx-writer-18089.conf`、`writer.caddy`、`writer-offline.html/.json`），改动后复制到对应机器。

**备份**（`C:\writer\backup-writer.ps1`，任务 Writer Backup，每 6 小时）：

1. `pg_dump` 整个数据库（项目、文件、版本、批注，除模板库外的全部数据）到 `D:\writer-backups`，保留 14 天，并用 `pg_restore --list` 检查能否读取；
2. 用这台电脑连北京服务器的 SSH 配置（`~/.ssh/config` 的 `beijing`）复制到北京服务器 `~/writer-backups`，按 SHA-256 核对；北京那边保留最近两天的全部，以及 14 天内每天一份；
3. 每周一次恢复演练：用 postgres 账号（密码在 `secrets.json`）把最新备份恢复到临时数据库 `writer_restore_check`，核对账号数、项目数和数据库版本后删掉，结果记在 `C:\writer\logs\restore-drill.json`；
4. 把这次的结果（成功与否、各盘剩余空间、演练结果）写成 `C:\writer\logs\lab-status.json`，复制到北京服务器 `~/writer-monitor/lab-status.json` 给监控读。

日志在 `C:\writer\logs\backup.log`。实验室电脑整台损坏时，从北京服务器取回最新的 `.dump`，在新机器上按“首次搭建要点”装好 PostgreSQL 后 `pg_restore` 即可。

**监控**（`deploy/lab/writer-monitor.py`，北京服务器 `admin` 和洛杉矶服务器 `ytranslator` 的 crontab 每分钟运行一次，文件在各自的 `~/writer-monitor`）：

- 经本机反向代理访问 `/api/health`，连续 3 分钟打不开就提醒，并区分是代理出错还是隧道/实验室电脑断了；之后每 2 小时提醒一次，恢复时再发一条；
- `/api/health` 的 `ai` 为 false 超过 10 分钟：AI 执行器（Writer Runner）没连上；
- 只在北京：超过 7 小时没收到 `lab-status.json`、备份或复制失败、恢复演练失败或超过 9 天没做、实验室 C: 少于 20 GB、D: 少于 50 GB；每周一 9 点（北京时间）发一份周报；
- 本机磁盘：北京少于 3 GB、洛杉矶少于 1.5 GB。

提醒由飞书应用 `cli_aa42ca90e8b8dbc0` 的机器人发给管理员本人（`~/writer-monitor/feishu.json`：`app_id`、`app_secret`、`receive_id_type`、`receive_id`，只有所有者能读）。要发到群里：把机器人拉进群，`receive_id_type` 改为 `chat_id`、`receive_id` 填群的 `oc_…`。`python3 ~/writer-monitor/writer-monitor.py --test` 发一条测试消息。日志 `monitor.log`，状态 `state.json`。

**离线页**：北京 nginx（`/etc/nginx/conf.d/writer-18089.conf`）连不上实验室时，网页返回 `/var/www/writer/writer-offline.html`（说明情况，每 20 秒检查一次，恢复后自动刷新），API 返回 JSON 错误，状态码都是 503。洛杉矶的 Caddy 配置了 `admin off`，改配置必须重启 Caddy（会让那台服务器上的其他网站断开一两秒），同样的离线页配置已放在 `/etc/caddy/writer.caddy.offline-pending`，择时 `sudo cp /etc/caddy/writer.caddy.offline-pending /etc/caddy/writer.caddy && sudo systemctl restart caddy` 启用。

**还需要人工做的**：给这台电脑配一台 UPS；在 BIOS 里打开“来电自动开机”（Restore on AC Power Loss），停电恢复后服务会随开机自动启动。

## 更新

```powershell
cd C:\writer\app
git pull
pnpm.cmd install --frozen-lockfile --filter "@lmms-lab/writer-collaboration..."
pnpm.cmd --filter @lmms-lab/writer-collaboration build
Stop-ScheduledTask -TaskPath "\Writer\" -TaskName "Writer Server"; Start-ScheduledTask -TaskPath "\Writer\" -TaskName "Writer Server"
Stop-ScheduledTask -TaskPath "\Writer\" -TaskName "Writer Runner"; Start-ScheduledTask -TaskPath "\Writer\" -TaskName "Writer Runner"
```

## 公网访问

服务器经两条 SSH 反向隧道对外：北京阿里云 `http://101.200.37.236:18089` 和洛杉矶 `https://writer.desire-drive.com`，这两个地址都写在 `WRITER_ORIGIN` 里（另设了 `WRITER_TRUST_PROXY=1`）。实测（2026-10-10）一次请求：校园网内直连约 10 毫秒，经北京约 60 毫秒，经洛杉矶 1–2 秒（这台电脑到洛杉矶往返约 220 毫秒，经洛杉矶访问要跨太平洋来回两次；从校园网直连该域名还会失败）。所以：

- 校园网内用 `http://<这台电脑的 IP>`；国内校外用北京地址；洛杉矶域名只留给国外的合作者；
- 浏览器开着全局代理时，国内地址也会绕到国外，访问 Writer 前请把这些地址设为直连；
- 网页的脚本和样式已压缩（Brotli/gzip）并长期缓存，第一次打开之后再进只需下载很少的数据。

首页和登录页右上角有“线路”切换，列出 `server.env` 里 `WRITER_ADDRESSES=campus=http://10.100.147.57,china=http://101.200.37.236:18089,global=https://writer.desire-drive.com` 的三个地址（内网、国内、海外），访问者按自己所在的位置换到更快的那个。切换时停在同一页（登录、注册表单和邀请链接都保留）；各地址的登录状态互不相通，换过去可能要重新登录。改地址后重启 Writer Server。

## 常见问题

- **IP 变了**：地址由 DHCP 分配。用新 IP 打开网页可以直接登录；邀请链接用的是 `WRITER_ORIGIN` 的第一个地址，改成新地址并重启 Writer Server 即可。能管理路由器时为这台电脑做 DHCP 地址保留。用域名访问（经反向代理）时必须把域名写进 `WRITER_ORIGIN`。
- **页面偶尔提示“项目权限已变更”或突然变成只读**：以前服务器在数据库短暂不可用（例如 PostgreSQL 重启）时会把在线页面当作失去权限。现在只有确实未登录、不再是成员或项目不存在时才会这样，临时故障时页面自动重连；页面收到这类断开时也会先向服务器确认一次权限。
- **AI 任务一直排队**：看 `runner.log` 和任务计划程序里 Writer Runner 是否在运行。
- **恢复备份**：停止 Writer Server，`pg_restore -h 127.0.0.1 -U writer -d writer --clean D:\writer-backups\<文件>.dump`，再启动。D: 上没有时，用北京服务器 `~/writer-backups` 里的副本。
- **Zotero 导入失败**：服务器经本机代理（mihomo）访问 `api.zotero.org`；代理不通时网页会提示连不上 Zotero。
