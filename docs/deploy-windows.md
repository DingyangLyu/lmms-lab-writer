# 在 Windows 11 专业版上部署协作服务并开放到公网

只在实验室内网使用、不想装 Docker 时，见 [deploy-windows-lan.md](deploy-windows-lan.md)。

这份说明把协作服务（`apps/collaboration`）跑在一台 Win11 专业版电脑上：用 Docker Desktop 运行服务、PostgreSQL 和每日备份，再由 Caddy 自动申请 HTTPS 证书，通过路由器把 80/443 端口转发到这台电脑。

```
组员浏览器 / 桌面端 ──HTTPS──▶ 路由器 80/443 ──▶ Win11: Caddy ──▶ writer ──▶ PostgreSQL
```

## 先确认三件事

1. **有公网 IPv4。** 登录路由器看 WAN 口 IP，再用手机流量以外的网络打开 <https://ip.sb>。两者一致才是公网 IP。WAN 口是 `10.x`、`100.64–127.x`、`172.16–31.x`、`192.168.x` 时是运营商内网，端口转发无效；可以打电话给运营商申请公网 IP，或改用 Cloudflare Tunnel。
2. **有一个域名。** 购买的域名或免费动态域名（如 DuckDNS）都可以，下面用 `writer.example.com` 代指。HTTPS 证书只能签给域名。
3. **运营商没有封 80/443。** 国内家庭宽带经常封入站 80/443，解析到国内 IP 的未备案域名也可能被拦。部署完成后用手机流量访问一次即可确认，遇到问题见文末。

## 1. 安装 Docker Desktop

1. 以管理员身份打开 PowerShell，执行 `wsl --install`，按提示重启。
2. 安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，安装时选 WSL 2。
3. Docker Desktop → Settings → General，勾选 **Start Docker Desktop when you sign in to your computer**。

## 2. 获取代码并填写配置

安装 [Git for Windows](https://git-scm.com/download/win) 后，在 PowerShell 中：

```powershell
cd $HOME
git clone https://github.com/DingyangLyu/lmms-lab-writer.git
cd lmms-lab-writer
Copy-Item apps\collaboration\.env.example .env
notepad .env
```

在 `.env` 中至少填写：

```ini
WRITER_ADMIN_USER=admin
WRITER_ADMIN_PASSWORD=至少12位的初始管理员密码
WRITER_POSTGRES_PASSWORD=只用字母和数字的数据库密码
WRITER_DOMAIN=writer.example.com
WRITER_ORIGIN=https://writer.example.com
WRITER_TRUST_PROXY=1
```

- `WRITER_ORIGIN` 必须和大家在浏览器里打开的地址完全一致（`https://` 开头，不带结尾斜杠），否则登录和实时协作会被拒绝。
- `WRITER_TRUST_PROXY=1` 让服务从 Caddy 转发的请求头里取真实访问者 IP，登录限流才按人计算。不经过 Caddy 时不要设置。
- 管理员密码只用于第一次创建管理员账号，之后可以在网页里修改。

## 3. 固定内网 IP、端口转发、防火墙

1. **固定内网 IP**：在路由器的 DHCP 设置里给这台电脑做地址保留（例如 `192.168.1.20`）。
2. **端口转发**：在路由器上把外网 TCP 80、TCP 443（可选再加 UDP 443）转发到 `192.168.1.20` 的同一端口。只转发这两个端口，**不要转发 8787 或 5432**。
3. **Windows 防火墙**（管理员 PowerShell）：

   ```powershell
   New-NetFirewallRule -DisplayName "Writer HTTPS" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow
   New-NetFirewallRule -DisplayName "Writer HTTP/3" -Direction Inbound -Protocol UDP -LocalPort 443 -Action Allow
   ```

## 4. 域名解析

在域名服务商处添加 A 记录：`writer.example.com → 你的公网 IP`。公网 IP 会变的话，开启路由器自带的 DDNS，或运行 [ddns-go](https://github.com/jeessy2/ddns-go) 之类的工具自动更新解析。

## 5. 启动

```powershell
cd $HOME\lmms-lab-writer
docker compose --profile https up -d --build
```

第一次构建会下载 TeX Live（用于网页端编译 PDF），镜像约 3 GB，需要十几分钟到半小时。之后查看状态：

```powershell
docker compose ps
docker compose logs -f caddy
```

Caddy 日志出现 `certificate obtained successfully` 后，用手机流量打开 `https://writer.example.com`，用 `.env` 里的管理员账号登录，按提示改密码，再在“用户管理”里给组员建账号。

## 6. 让它一直在线

- **不睡眠**：设置 → 系统 → 电源 → 屏幕和睡眠，“插入电源后使设备进入睡眠状态”选“从不”。
- **重启后自动恢复**：Docker Desktop 在用户登录后才启动；所有容器都设置了 `restart: unless-stopped`，Docker 启动后会自动拉起。如果希望停电或更新重启后无人值守恢复，可以在 `netplwiz` 中设置自动登录（会降低这台电脑本身的安全性），或者保持登录后用 Win+L 锁屏。
- **Windows 更新**：设置 → Windows 更新 → 高级选项 → 使用时段，避免在组员常用的时间自动重启。

## 7. 备份与恢复

`backup` 服务每天用 `pg_dump` 生成一份备份，默认保留 14 天（`.env` 中的 `WRITER_BACKUP_KEEP_DAYS`）。这些备份在 Docker 卷里，和数据在同一块硬盘上，请定期复制到别处：

```powershell
docker compose cp backup:/backups .\backups
```

恢复某一份备份（会覆盖当前数据，先停掉服务）：

```powershell
docker compose stop writer
docker compose cp .\backups\writer-20260101-030000.dump postgres:/tmp/restore.dump
docker compose exec postgres pg_restore -U writer -d writer --clean --if-exists /tmp/restore.dump
docker compose start writer
```

## 8. 升级

```powershell
cd $HOME\lmms-lab-writer
git pull
docker compose --profile https up -d --build
```

数据库结构升级在服务启动时自动执行。

## 常见问题

**Caddy 一直拿不到证书。** 检查 A 记录是否已指向当前公网 IP（`nslookup writer.example.com`）、路由器转发和防火墙是否放行了 80，以及 `.env` 中的 `WRITER_DOMAIN` 是否拼写正确。证书签发失败几次后会被限速，修好后等待片刻即可。

**手机流量打不开，局域网里能打开。** 多半是运营商封了 80/443，或者没有公网 IP。可选的办法：
- 向运营商申请开放端口或改用商业宽带；
- 改用 Cloudflare Tunnel：不需要公网 IP 和端口转发，证书由 Cloudflare 提供（域名需托管在 Cloudflare）；
- 只给组员使用时，可以用 Tailscale 组建私有网络，组员装客户端后通过内网地址访问，服务完全不暴露在公网上。

**登录提示“请求来源不匹配”或协作一直显示断线。** `WRITER_ORIGIN` 与浏览器地址不一致。修改 `.env` 后执行 `docker compose --profile https up -d` 让它生效。

**安全建议。** 只开放 80/443；管理员和组员都使用长密码；离开实验室的成员及时在“用户管理”中停用；把备份定期复制到另一台机器或网盘。
