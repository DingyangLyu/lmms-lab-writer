# 在实验室 Ubuntu 工作站上部署（ubuntu-lan，现用）

2026 年 10 月 26 日起，实验室的 Writer 服务器从 Windows 电脑 DESKTOP-0L24B21（见 [deploy-windows-lan.md](deploy-windows-lan.md)，现为备用）迁到 Ubuntu 24.04 工作站 ubuntu-lan（10.100.22.131，主机名 `yuanbai`，20 核、30 GB 内存）。数据、模板库、安装包、公网线路、备份和监控都一起迁了过来；组员在校园网里打开 `http://10.100.22.131`，校外仍用北京和洛杉矶两个地址。

```
校园网浏览器 ──HTTP :80──▶ nginx 容器 writer-port80 ──┐
北京 nginx / 洛杉矶 Caddy ──SSH 反向隧道（18090）────────┴▶ node（Writer Server，127.0.0.1:8790）
                                                          ├─▶ PostgreSQL 17 容器 writer-postgres（127.0.0.1:5433）
                                    Writer Runner ────────┤   └─▶ TeX Live 2026（PDF 预览编译）
                       Codex / OpenCode（这台电脑登录的账号）
```

这台电脑上 yuanbai 没有 sudo（但在 docker 组里），所以：PostgreSQL 和 80 端口的转发放在 Docker 容器里（`--restart unless-stopped`，随 Docker 开机启动）；其余都是 yuanbai 的 systemd 用户服务（已开启 linger，不登录也运行）。这也是一台日常在用的工作站（COMSOL、Fluent、Y-Translator 的 PDF worker 等都在上面），改动时不要影响其他服务。

## 目录和服务

| 位置 | 内容 |
| --- | --- |
| `~/writer/app` | 本仓库（从 GitHub `git pull` 更新） |
| `~/writer/config/server.env`、`runner.env` | 服务端、执行器配置（权限 600，目录 700） |
| `~/writer/config/secrets.json`、`postgres.env`、`pgpass.conf` | 数据库密码、管理员初始密码、执行器令牌（沿用 Windows 上的） |
| `~/writer/config/ssh_config`、`writer_tunnel_ed25519`、`known_hosts` | 隧道和异地备份连北京、洛杉矶用的 SSH 配置和专用密钥 |
| `~/writer/config/nginx-port80.conf` | 80 端口转发（只放行 10.100.0.0/16 和本机） |
| `~/writer/config/fonts.conf` | 编译用的 fontconfig 配置（见“中文字体”） |
| `~/writer/config/windows-original/` | 从 Windows 拷来的原始配置，留作对照 |
| `~/writer/templates`、`~/writer/downloads` | 模板库、网页“桌面端”页的安装包 |
| `~/writer/data` | `WRITER_DATA_DIR`，以及字体缓存 `fontconfig-cache` |
| `~/writer/bin/writer-tunnel`、`writer-backup` | 隧道和备份脚本（仓库 `deploy/ubuntu/`） |
| `~/writer/logs` | `backup.log`、`lab-status.json`、`restore-drill.json`（服务端和执行器的日志在 journald） |
| Docker 卷 `writer-pgdata` | PostgreSQL 数据（容器 `writer-postgres`，镜像 `postgres:17`，`--locale=C` UTF8） |
| `~/texlive/2026` | TeX Live 2026 scheme-full（不含文档和源码，A4）；`~/texlive/texmf-local` 放本地配置 |
| `~/.local/opt/node` | Node 24.20.0；全局装了 pnpm 11.5.0、`@openai/codex`、`opencode-ai`、`@larksuite/cli` |
| `/media/yuanbai/E0592753F720D15B/writer-backups` | 1 TB USB 机械盘上的数据库备份和模板库镜像 |

systemd 用户服务（`~/.config/systemd/user`，仓库 `deploy/ubuntu/systemd/`）：

- `writer-server`：`server/main.ts`，退出 5 秒后重启。开机时 Docker 还没起好 PostgreSQL 就会退出重试，属正常。
- `writer-runner`：`server/runner.ts`（网页 AI 对话）。
- `writer-tunnel@beijing`、`writer-tunnel@la`：两条公网隧道。
- `writer-backup.timer`：北京时间 0、6、12、18 点运行 `writer-backup.service`。

常用命令：`systemctl --user status writer-server`、`journalctl --user -u writer-server -f`、`docker ps --filter name=writer-`。

## 首次搭建要点（2026-10-26 做过的）

1. Node 24 的 Linux 压缩包（npmmirror 镜像）解压到 `~/.local/opt`，链接为 `~/.local/opt/node`；`npm install -g --registry=https://registry.npmmirror.com pnpm@11.5.0 @openai/codex opencode-ai @larksuite/cli`。
2. TeX Live：清华镜像的 `install-tl-unx.tar.gz`，用 `deploy/ubuntu/texlive.profile`（scheme-full、`TEXDIR ~/texlive/2026`、不装文档源码、A4）安装，十几分钟。系统自带的 TeX Live 2023（apt）不用；服务的 PATH 把 2026 放在最前。Ghostscript 用系统的 `/usr/bin/gs`（TeX Live 的 `rungs` 会调用它）。
3. PostgreSQL：`docker run -d --name writer-postgres --restart unless-stopped --env-file ~/writer/config/postgres.env --shm-size=256m -v writer-pgdata:/var/lib/postgresql/data -p 127.0.0.1:5433:5432 postgres:17`，再建 `writer` 用户和数据库。容器里本地连接免密码（备份脚本用 `docker exec`），从宿主经端口连要密码。
4. 80 端口：`docker run -d --name writer-port80 --restart unless-stopped --network host -v ~/writer/config/nginx-port80.conf:/etc/nginx/conf.d/default.conf:ro nginx:1.29-alpine`。服务端只监听 127.0.0.1，且 `WRITER_TRUST_PROXY=1`：nginx 和公网中转都会带上 `X-Forwarded-For`，隧道直接连 8790、不经过这层 nginx。这台电脑没开 ufw，nginx 的 allow/deny 起到原来 Windows 防火墙的作用。
5. 代码：`git clone https://github.com/DingyangLyu/lmms-lab-writer.git ~/writer/app`，`pnpm install --frozen-lockfile --filter "@lmms-lab/writer-collaboration..."`，`pnpm --filter @lmms-lab/writer-collaboration build`。
6. 数据：Windows 上 `pg_dump -Fc`，这边 `docker exec -i writer-postgres pg_restore -U writer -d writer --no-owner --role=writer --exit-on-error < x.dump`；模板库（含 `.cache`）和安装包原样拷过来。

## 中文字体

Windows 上 ctex 默认用 Windows 字体集，Linux 上默认用 Fandol，学位论文等的字形会变。为保持和以前一样（用户 2026-10-26 同意）：

- 从实验室 Windows 电脑拷来宋体、黑体、楷体、仿宋、微软雅黑、等线、华文字体和 Times New Roman、Arial、Calibri、Cambria 等，放在 `~/.local/share/fonts/windows-lab`（只在实验室内部使用），并链接为 `~/texlive/texmf-local/fonts/truetype/windows-lab`，pdfLaTeX 和按文件名找字体的 XeLaTeX 都能用。
- `~/texlive/texmf-local/tex/latex/ctex/ctexopts.cfg`（仓库 `deploy/ubuntu/ctexopts.cfg`）把 ctex 的默认 `fontset` 设为 `windows`；文档自己指定的字体集照常生效。
- 服务端编译时把 `HOME` 设成构建目录，fontconfig 看不到 `~/.local/share/fonts`，按字体名找 SimHei 的模板（pkuthss、ucasthesis）会卡到超时。所以 `server.env` 里设了 `FONTCONFIG_FILE=~/writer/config/fonts.conf`（写明字体目录的绝对路径和缓存目录），服务端会把它传给 TeX。新加字体后运行 `HOME=$(mktemp -d) FONTCONFIG_FILE=/home/yuanbai/writer/config/fonts.conf fc-cache` 刷新缓存。

迁移时 4 个学位论文模板在两边编译出的 PDF 字体和页数完全一致；33 个官方模板全部编译通过。

## AI 执行器

- Codex 用这台电脑 `~/.codex` 的登录（2804761170@qq.com，Pro；VS Code 插件和 codex-mailbox-worker 也在用，额度共享）。不要复制别处的 `auth.json`。
- `WRITER_CODEX_SANDBOX=danger-full-access`，网页上 Codex 只提供“完全访问”（用户 2026-10-26 选择与 Windows 保持一致）：组员的提示词能以 yuanbai 的权限访问这台工作站上的所有文件，包括各处的 SSH 密钥。只给信任的组员编辑权限。想收紧时删掉这一行（Linux 上 Codex 沙箱可用），或用 `WRITER_CODEX_PERMISSIONS=readOnly,askForApproval,autoReview` 去掉完全访问，然后重启 `writer-runner`。
- OpenCode 的配置和登录从 Windows 拷来（`~/.config/opencode`、`~/.local/share/opencode/auth.json`：Kimi、DeepSeek、OpenAI OAuth）。OpenAI 的 OAuth 刷新令牌会轮换，Windows 上的那份已不再使用，不要再在 Windows 上启动 OpenCode。
- 代理：FlClash（桌面开机自动登录后启动，TUN 开着，混合端口 `127.0.0.1:7897`），`runner.env` 的 `HTTPS_PROXY` 指向它。
- 迁移前 Windows 上的 2 个网页 AI 对话的上下文在 Windows 的 Codex/OpenCode 里，这边不能接着聊，历史标题还在。
- 飞书 CLI：`lark-cli` 配置为监控用的飞书应用（`cli_aa42ca90e8b8dbc0`，密钥加密存在 `~/.local/share/lark-cli`），后台服务里也能以机器人身份调用；以管理员本人身份用文档、日历要先 `lark-cli auth login`。

## 公网隧道

`writer-tunnel@<beijing|la>` 运行 `~/writer/bin/writer-tunnel`：`ssh -N -R 127.0.0.1:18090:127.0.0.1:8790`，退出 5 秒后由 systemd 重启。连接一开始就失败（多半是中转服务器上的旧会话还占着 18090）时，脚本登录中转服务器结束占着端口的 sshd，再重连，与 Windows 上的 `run-writer-tunnel.ps1` 相同。用的是这台电脑的专用密钥 `writer_tunnel_ed25519`（已加进北京 `admin` 和洛杉矶 `ytranslator` 的 `authorized_keys`）。

- 重启隧道：`systemctl --user restart writer-tunnel@beijing`（或 `@la`）。
- 试改脚本时可以 `~/writer/bin/writer-tunnel beijing 18091` 在另一个端口试，不影响正在用的隧道。
- 不要同时让 Windows 和这台电脑都连 18090：两边的清理逻辑会互相踢掉对方。

## 备份、监控和提醒

`writer-backup`（每 6 小时）：`pg_dump` 到 USB 盘 `writer-backups`（盘没接上时写到 `~/writer/backups` 并报警），保留 14 天，`pg_restore --list` 检查；模板库镜像到旁边的 `templates/`；复制到北京 `~/writer-backups` 并核对 SHA-256；每周一次恢复演练；状态写到北京 `~/writer-monitor/lab-status.json`。日志 `~/writer/logs/backup.log`，手动运行 `systemctl --user start writer-backup`。

北京和洛杉矶的 `writer-monitor.py` 不变（见 [deploy-windows-lan.md](deploy-windows-lan.md) 的“备份、监控和提醒”），磁盘阈值改为“系统盘”20 GB、“备份盘”50 GB（`deploy/lab/monitor-config.beijing.json`）。

**恢复备份**：`systemctl --user stop writer-runner writer-server`，`docker exec -i writer-postgres pg_restore -U writer -d writer --clean --if-exists < <文件>.dump`，再启动。

## 更新

```bash
cd ~/writer/app && git pull --ff-only
export PATH=$HOME/.local/opt/node/bin:$PATH npm_config_registry=https://registry.npmmirror.com
pnpm install --frozen-lockfile --filter "@lmms-lab/writer-collaboration..."
pnpm --filter @lmms-lab/writer-collaboration build
systemctl --user restart writer-server writer-runner
```

带数据库迁移的更新，先 `systemctl --user start writer-backup` 并确认 `backup.log` 里成功。`deploy/ubuntu/` 下的脚本和服务改动后，复制到 `~/writer/bin`、`~/writer/config`、`~/.config/systemd/user`，再 `systemctl --user daemon-reload`。模板库重新构建见 Windows 文档“模板库”一节，路径换成 `--out ~/writer/templates`，`WRITER_LATEXMK=~/texlive/2026/bin/x86_64-linux/latexmk`。

## 原 Windows 电脑

- `\Writer\` 下的三个任务已禁用，PostgreSQL 服务和 `C:\writer` 原样保留（数据停在 2026-10-26 切换时）；切换前的最后一份备份是 `D:\writer-backups\writer-20261025-2251.dump`（北京也有）。
- 它的 80 端口用 Windows 自带的端口转发指向这台电脑：`netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80 connectaddress=10.100.22.131 connectport=80`，旧地址 `http://10.100.147.57` 的书签和桌面端设置继续可用（网页里看到的客户端地址会是那台 Windows）。不再需要时 `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80`。
- 那台电脑上的 Y-Translator 隧道（18190 端口）和 mihomo 与 Writer 无关，照常运行。
- **回退**：停掉这边的 `writer-server writer-runner writer-tunnel@beijing writer-tunnel@la writer-backup.timer`，把这边的最新备份恢复到 Windows 的 PostgreSQL，删掉 portproxy，再启用并启动 Windows 上的三个任务。

## 常见问题

- **IP 变了**：网卡地址由 DHCP 分配。改 `server.env` 的 `WRITER_ORIGIN`、`WRITER_ADDRESSES` 的 campus 地址和 Windows 上 portproxy 的目标，重启 `writer-server`。
- **AI 对话不可用**：`journalctl --user -u writer-runner`；看 FlClash 是否在运行（`curl -x http://127.0.0.1:7897 https://api.openai.com`）。
- **编译时找不到中文字体**：确认 `server.env` 里有 `FONTCONFIG_FILE`，且 `HOME=$(mktemp -d) FONTCONFIG_FILE=… fc-match SimHei` 返回 `simhei.ttf`。
