# 在实验室 Windows 电脑上部署（内网，不用 Docker）

实验室工作站 DESKTOP-0L24B21 用的就是这种方式：协作服务直接用 Node 跑在 Windows 上，数据放在本机 PostgreSQL，组员在校园网里打开 `http://<这台电脑的 IP>`。同一台电脑上的 Codex 作为“共享执行器”，为所有项目提供网页右侧的 AI 对话（与桌面端同一个面板）。需要公网访问时，再按 [deploy-windows.md](deploy-windows.md) 加 HTTPS 或经一台公网服务器转发。

```
组员浏览器 / 桌面端 ──HTTP :80──▶ node（Writer Server）──▶ PostgreSQL（本机）
                                   ▲              └──▶ TeX Live（PDF 预览编译）
                 Writer Runner ────┘  Codex / OpenCode（这台电脑登录的账号）
```

## 目录和后台任务

| 位置 | 内容 |
| --- | --- |
| `D:\writer\app` | 本仓库（`git pull` 更新） |
| `D:\writer\config\server.env` | 服务端配置：监听地址、`WRITER_ORIGIN`、数据库 URL、共享执行器令牌 |
| `D:\writer\config\runner.env` | 执行器配置：只有执行器令牌、Codex/OpenCode 路径和代理 |
| `D:\writer\config\secrets.json` | 首次生成的密码和令牌（数据库、管理员初始密码、执行器） |
| `D:\writer\pgsql`、`D:\writer\pgdata` | PostgreSQL 17 程序和数据（服务 `postgresql-writer`，只监听 127.0.0.1） |
| `D:\texlive\current` | TeX Live（服务端编译 PDF 用的 latexmk） |
| `D:\writer\logs` | `server.log`、`runner.log`、`backup.log` |
| `D:\writer\backups` | 每天 3 点的数据库备份，保留 14 天 |
| `%USERPROFILE%\.writer-runner\projects` | AI 对话的项目工作副本（每个项目一份；可以删除，每轮开始前会从服务器重新同步） |

任务计划程序里 `\Writer\` 下的三个任务都以 yuanbai 身份、“不管用户是否登录都运行”：

- **Writer Server**：开机启动 `run-writer.ps1 -Name server`，进程退出 5 秒后自动重启。
- **Writer Runner**：开机启动 `run-writer.ps1 -Name runner`，以最高权限运行。
- **Writer Backup**：每天 3 点运行 `backup-writer.ps1`（`pg_dump`）。

`config` 下的文件只有 yuanbai 和 SYSTEM 能读。

## 首次搭建要点

1. Node LTS：`winget install OpenJS.NodeJS.LTS`，再 `npm install -g pnpm @openai/codex opencode-ai`。
2. PostgreSQL：这台电脑上 EnterpriseDB 安装器写不了临时 `.bat` 文件，所以用官方免安装包：解压到 `D:\writer\pgsql`，`initdb -D D:\writer\pgdata -U postgres -A scram-sha-256 -E UTF8 --locale=C`，给 `NT AUTHORITY\NetworkService` 授予数据目录权限，`pg_ctl register -N postgresql-writer -S auto -U "NT AUTHORITY\NetworkService"`，再建 `writer` 用户和数据库。
3. TeX Live：从清华镜像下载 `install-tl.zip`，用 profile 安装 `scheme-full`（不装文档和源码）到 `D:\texlive\current`。
4. 代码：`pnpm install --frozen-lockfile --filter "@lmms-lab/writer-collaboration..."`，`pnpm --filter @lmms-lab/writer-collaboration build`。
5. `server.env`：`WRITER_HOST=0.0.0.0`、`WRITER_PORT=80`、`WRITER_ORIGIN=http://<IP>`、`WRITER_DATABASE_URL`、`WRITER_ADMIN_USER/PASSWORD`（只在数据库还没有用户时创建管理员）、`WRITER_SHARED_RUNNER_TOKEN`（`openssl rand -hex 32` 形式的 64 位十六进制）及其名称和能力（`codex,opencode`）。可选 `WRITER_TEMPLATES_DIR=D:\writer\templates` 放实验室自己的项目模板。
6. `runner.env`：`WRITER_SERVER=http://127.0.0.1`、`WRITER_RUNNER_TOKEN`（同上）、`WRITER_ALLOWED_HARNESSES`、`WRITER_CODEX_BIN`/`WRITER_OPENCODE_BIN`（指向 npm 包里的 `codex.exe`、`opencode.exe`，避开 `.cmd`）、`WRITER_CODEX_SANDBOX=danger-full-access`、`HTTPS_PROXY`/`HTTP_PROXY`（本机代理）和 `NO_PROXY=127.0.0.1,localhost,::1`。
7. 防火墙：只放行校园网访问 80 端口，例如 `New-NetFirewallRule -Name Writer-HTTP-LAN -Direction Inbound -Protocol TCP -LocalPort 80 -RemoteAddress 10.100.0.0/16 -Action Allow`。
8. 接电源时不睡眠：`powercfg /change standby-timeout-ac 0`、`powercfg /change hibernate-timeout-ac 0`。

## AI 执行器

- Codex 用这台电脑上 `~/.codex` 的登录（与 Codex 桌面版共用，不要复制 `auth.json`，ChatGPT 登录的刷新令牌会轮换，副本会互相作废）；OpenCode 用 `~/.local/share/opencode/auth.json` 和 `~/.config/opencode/opencode.json`。所有 AI 任务都消耗这个账号的额度。
- Codex 在 Windows 的后台任务里无法使用自身沙箱，所以设为 `danger-full-access`：组员的提示词能以 yuanbai 的权限访问这台电脑上的文件（包括上面的凭据）。只给信任的组员编辑权限。执行器不会把 `WRITER_*` 令牌、密码和数据库 URL 交给 AI。
- 访问 OpenAI 需要本机代理（FlClash）可用；代理不通时 Codex 对话会报错，OpenCode 用的国内模型不受影响。
- 网页 AI 对话：Writer Runner 启用了 `codex` 能力时，会再连一条 WebSocket 到服务器（`/api/runner/agents`，同一个共享执行器令牌），由一个 `codex app-server` 服务所有项目。每个项目在 `%USERPROFILE%\.writer-runner\projects\<项目 ID>` 有一份工作副本，每轮开始前和服务器同步；Codex 每改完一步，改动就合并进共享正文（以发起这一轮的成员名义），与他人同时改到同一处的部分转为待审阅建议。每轮开始前服务器自动保存一个版本“AI 对话修改前”，可在“版本”里恢复。
- 只有项目的所有者和编辑者能用 AI 对话；对话默认只有发起人能看到，可在对话标题旁或“历史对话”里共享给项目成员。同一项目同时只运行一轮。
- 因为 `WRITER_CODEX_SANDBOX=danger-full-access`，网页上的权限只提供“完全访问”；其他机器可用 `WRITER_CODEX_PERMISSIONS=readOnly,askForApproval,autoReview,fullAccess` 指定。工作副本位置可用 `WRITER_AGENT_WORKSPACES` 改；`WRITER_AGENT_HOST=0` 关闭网页 AI 对话。
- 更新代码后要同时重启 Writer Server 和 Writer Runner（见下），网页 AI 对话才会用上新版本。

## 账号和注册

默认“注册后需管理员审核”：组员在登录页注册，管理员在“管理后台 → 待审核”批准后才能登录。管理后台还可以：

- 生成邀请链接（有效期、可用次数），拿到链接的人注册后直接可用；
- 改为“注册后直接可用”或“关闭注册”；
- 注销账号：历史评论和版本保留，账号名释放，对方唯一拥有的项目转给执行注销的管理员。

项目所有者发出的项目邀请，如果对方是新用户，账号同样要管理员审核（管理员自己发的项目邀请除外）。

## 网络（洛杉矶线路）

这台电脑不再用 FlClash 的机场订阅，而是用 mihomo（FlClash 的同一内核）作为系统服务，不登录也在运行：

- 程序和配置：`D:\net\mihomo`（`config.yaml` 只有 SYSTEM、管理员和 yuanbai 能读），日志 `D:\net\logs`；
- 任务计划程序 `\Network\Mihomo`（开机启动，退出后自动重启）和 `\Network\Mihomo Watchdog`（每 5 分钟经代理测试一次，连续 3 次失败就重启 mihomo）；
- 境外流量走洛杉矶服务器（出口 IP 固定）；国内网站（GeoSite/GeoIP 中国列表）、B 站、ToDesk、百度网盘、微信、QQ、钉钉、飞书、Windows 更新等直连；局域网地址不进 TUN；
- 本机代理端口仍是 `127.0.0.1:7890`，Writer 执行器经它访问 OpenAI；
- 需要再加直连的网站或程序：在 `config.yaml` 的 `rules` 里 `GEOSITE,cn,DIRECT` 之前加 `DOMAIN-SUFFIX,<域名>,DIRECT` 或 `PROCESS-NAME,<程序>.exe,DIRECT`，用 `D:\net\mihomo\mihomo.exe -t -d D:\net\mihomo` 检查后重启 Mihomo 任务；
- FlClash 仍安装着，但它的辅助服务已改为手动启动；不要同时打开 FlClash 的 TUN，否则两者会抢路由和 7890 端口。

## 更新

```powershell
cd D:\writer\app
git pull
pnpm install --frozen-lockfile --filter "@lmms-lab/writer-collaboration..."
pnpm --filter @lmms-lab/writer-collaboration build
Stop-ScheduledTask -TaskPath "\Writer\" -TaskName "Writer Server"; Start-ScheduledTask -TaskPath "\Writer\" -TaskName "Writer Server"
Stop-ScheduledTask -TaskPath "\Writer\" -TaskName "Writer Runner"; Start-ScheduledTask -TaskPath "\Writer\" -TaskName "Writer Runner"
```

## 常见问题

- **IP 变了，页面能打开但登录或保存报“请求来源不匹配”**：地址由 DHCP 分配。改 `server.env` 的 `WRITER_ORIGIN` 为新地址并重启 Writer Server；能管理路由器时为这台电脑做 DHCP 地址保留。
- **AI 任务一直排队**：看 `runner.log` 和任务计划程序里 Writer Runner 是否在运行。
- **恢复备份**：停止 Writer Server，`pg_restore -h 127.0.0.1 -U writer -d writer --clean D:\writer\backups\<文件>.dump`，再启动。
