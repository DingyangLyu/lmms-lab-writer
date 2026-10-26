#!/usr/bin/env python3
"""
Watches Writer from a public server that forwards to the lab machine (cron, every minute) and
tells the administrator on Feishu when something needs them, then again when it is fixed:

- the Writer address this server forwards (its reverse proxy, the SSH tunnel, the lab server);
- the AI runner (Codex / OpenCode for the web's AI conversations), from /api/health;
- the lab's status file, sent with every backup: backups, the off-site copy, restore drills,
  disk space (only where `lab_status` is configured);
- this server's own disk.

It also prunes the off-site backups it keeps (`backups`) and, where `weekly` is set, sends a
short report every Monday morning so a silent week means "all well", not "monitor dead".

Files next to this script: config.json (what to check), feishu.json (app_id, app_secret,
receive_id_type, receive_id; only the owner can read it), state.json and monitor.log.
Standard library only.
"""

import datetime as dt
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
TZ = ZoneInfo("Asia/Shanghai")
FAILS_BEFORE_ALERT = 3  # minutes
AI_GRACE = 10 * 60  # a deploy restarts the runner; it reconnects in seconds
REMIND_DOWN = 2 * 3600
REMIND_PROBLEM = 12 * 3600


def path(name):
    return os.path.join(HERE, name)


def load(name, default):
    try:
        with open(path(name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(name, value):
    tmp = path(name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path(name))


def log(text):
    file = path("monitor.log")
    try:
        if os.path.getsize(file) > 2_000_000:
            os.replace(file, file + ".1")
    except OSError:
        pass
    with open(file, "a", encoding="utf-8") as f:
        f.write(f"[{dt.datetime.now(TZ):%Y-%m-%d %H:%M:%S}] {text}\n")


def clock(ts):
    return dt.datetime.fromtimestamp(ts, TZ).strftime("%m-%d %H:%M")


def span(seconds):
    minutes = max(1, round(seconds / 60))
    if minutes < 60:
        return f"{minutes} 分钟"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} 小时 {minutes} 分钟" if minutes else f"{hours} 小时"


class Feishu:
    """Messages from the app's bot to one person (open_id) or group (chat_id)."""

    def __init__(self, state):
        self.config = load("feishu.json", None)
        self.state = state

    def token(self):
        cached = self.state.get("feishu_token")
        if cached and cached["expires"] > time.time() + 300:
            return cached["value"]
        body = {"app_id": self.config["app_id"], "app_secret": self.config["app_secret"]}
        data = request(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", body
        )
        if data.get("code") != 0:
            raise RuntimeError(f"token: {data.get('code')} {data.get('msg')}")
        self.state["feishu_token"] = {
            "value": data["tenant_access_token"],
            "expires": time.time() + int(data.get("expire", 7200)),
        }
        return data["tenant_access_token"]

    def send(self, text):
        if not self.config:
            log(f"(no feishu.json) {text}")
            return True
        try:
            kind = self.config.get("receive_id_type", "open_id")
            data = request(
                f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={kind}",
                {
                    "receive_id": self.config["receive_id"],
                    "msg_type": "text",
                    "content": json.dumps({"text": text}, ensure_ascii=False),
                },
                {"Authorization": f"Bearer {self.token()}"},
            )
            if data.get("code") != 0:
                raise RuntimeError(f"send: {data.get('code')} {data.get('msg')}")
            log(f"sent: {text}")
            return True
        except Exception as error:  # noqa: BLE001 - try again next minute
            self.state.pop("feishu_token", None)
            log(f"feishu failed ({error}): {text}")
            return False


def request(url, body=None, headers=None, timeout=15):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode())


def health(url):
    """(ok, detail, ai) for one address: Writer's /api/health ({"ok": true, "ai": ...}) or
    Y-Translator's /health ({"status": "ok"}), which the same lab machine serves."""
    try:
        data = request(url, timeout=10)
        return data.get("ok") is True or data.get("status") == "ok", "", data.get("ai")
    except urllib.error.HTTPError as error:
        return False, f"HTTP {error.code}", None
    except Exception as error:  # noqa: BLE001
        return False, type(error).__name__, None


class Problems:
    """Named conditions: alert when one appears, remind now and then, report when it clears."""

    def __init__(self, state, feishu, title):
        self.items = state.setdefault("problems", {})
        self.feishu = feishu
        self.title = title
        self.seen = set()

    def have(self, key, text, remind=REMIND_PROBLEM):
        self.seen.add(key)
        item = self.items.setdefault(key, {"since": time.time(), "alerted": 0})
        item["text"] = text
        now = time.time()
        if not item["alerted"]:
            if self.feishu.send(f"⚠️ {self.title}：{text}"):
                item["alerted"] = item["reminded"] = now
        elif now - item.get("reminded", 0) > remind:
            if self.feishu.send(
                f"⚠️ {self.title}（仍未解决，已 {span(now - item['since'])}）：{text}"
            ):
                item["reminded"] = now

    def settle(self, prefix=""):
        for key in [k for k in self.items if k.startswith(prefix) and k not in self.seen]:
            item = self.items[key]
            if not item["alerted"] or self.feishu.send(
                f"✅ {self.title}恢复正常（问题持续了 {span(time.time() - item['since'])}）\n"
                f"原问题：{item.get('text', '')}"
            ):
                del self.items[key]


def check_sites(config, state, problems):
    week = state.setdefault("week", {"start": time.time(), "up": 0, "down": 0})
    for site in config.get("sites", []):
        name, key = site["name"], f"site:{site['name']}"
        memory = state.setdefault("sites", {}).setdefault(name, {"fails": 0})
        ok, detail, ai = health(site["url"])
        memory["fails"] = 0 if ok else memory["fails"] + 1
        week["up" if ok else "down"] += 1
        # Alert after a few failed minutes; once alerted, it stays open until a check passes.
        if not ok and (memory["fails"] >= FAILS_BEFORE_ALERT or key in problems.items):
            reason = detail
            if site.get("direct"):
                reason = (
                    f"{site.get('proxy', '反向代理')}出错（隧道和实验室服务器正常）"
                    if health(site["direct"])[0]
                    else "实验室服务器、网络或 SSH 隧道断了（校园网内的地址可能也打不开）"
                )
            problems.have(key, f"{name} 打不开：{reason}", REMIND_DOWN)
        if ok and ai is False:
            memory.setdefault("ai_off", time.time())
            if time.time() - memory["ai_off"] > AI_GRACE:
                problems.have(
                    f"ai:{name}", "AI 执行器（Writer Runner）没有连上服务器，网页 AI 对话不可用"
                )
        elif ok:
            memory.pop("ai_off", None)
        elif f"ai:{name}" in problems.items:
            problems.seen.add(f"ai:{name}")  # unknown while the site is down


def resolve(file):
    file = os.path.expanduser(file)
    return file if os.path.isabs(file) else path(file)


def check_lab(config, state, problems):
    file = config.get("lab_status")
    if not file:
        return
    status = load(resolve(file), None)
    if not status:
        problems.have("lab:none", "还没有收到实验室电脑的备份状态")
        return
    age = time.time() - status.get("time", 0)
    if age > config.get("lab_max_age_hours", 7) * 3600:
        problems.have(
            "lab:stale",
            f"超过 {span(age)} 没有收到实验室电脑的备份（上次 {clock(status.get('time', 0))}）："
            "备份任务没有运行、电脑关机或连不上北京服务器",
        )
    for text in status.get("problems", []):
        problems.have(f"lab:problem:{text}", text)
    for drive, free in (status.get("disks") or {}).items():
        least = config.get("lab_disk_min_gb", {}).get(drive)
        # A Windows drive letter ("C") or a name the Ubuntu backup gives ("系统盘").
        label = f"{drive}:" if len(drive) == 1 else drive
        if least and free < least:
            problems.have(f"lab:disk:{drive}", f"实验室电脑 {label} 只剩 {free:.0f} GB")
    drill = status.get("drill") or {}
    if drill.get("time") and time.time() - drill["time"] > 9 * 86400:
        problems.have("lab:drill", f"恢复演练超过 9 天没有做（上次 {clock(drill['time'])}）")


def check_disk(config, problems):
    least = config.get("disk_min_gb")
    if not least:
        return
    free = shutil.disk_usage("/").free / 1e9
    if free < least:
        problems.have("disk:self", f"{config['title']}所在服务器磁盘只剩 {free:.1f} GB")


def prune_backups(config):
    """Every dump from the last two days, then the first of each day, for 14 days."""
    folder = config.get("backups")
    if not folder:
        return
    folder = resolve(folder)
    try:
        names = sorted(n for n in os.listdir(folder) if n.startswith("writer-") and n.endswith(".dump"))
    except OSError:
        return
    now = time.time()
    kept_days = set()
    for name in names:
        file = os.path.join(folder, name)
        age = now - os.path.getmtime(file)
        day = name[7:15]
        if age > 14 * 86400 or (age > 2 * 86400 and day in kept_days):
            os.remove(file)
            log(f"pruned {name}")
        else:
            kept_days.add(day)


def weekly(config, state, feishu):
    if not config.get("weekly"):
        return
    now = dt.datetime.now(TZ)
    stamp = now.strftime("%G-W%V")
    if "weekly_sent" not in state:  # the first report comes after a whole week
        state["weekly_sent"] = stamp
    if now.weekday() != 0 or now.hour < 9 or state.get("weekly_sent") == stamp:
        return
    week = state.get("week", {"up": 0, "down": 0})
    total = week["up"] + week["down"]
    share = f"{100 * week['up'] / total:.2f}%" if total else "无数据"
    status = load(resolve(config["lab_status"]), {}) if config.get("lab_status") else {}
    drill = status.get("drill") or {}
    lines = [
        f"🗓 Writer 每周检查（{config['title']}）",
        f"过去一周可访问：{share}",
        f"最近备份：{clock(status['time']) if status.get('time') else '无'}"
        + (f"（{status.get('bytes', 0) / 1e6:.0f} MB，已复制到北京）" if status.get("offsite") else ""),
        f"最近恢复演练：{clock(drill['time']) + ('，成功' if drill.get('ok') else '，失败') if drill.get('time') else '尚未进行'}",
    ]
    open_problems = [p.get("text", k) for k, p in state.get("problems", {}).items()]
    lines.append("未解决：" + "；".join(open_problems) if open_problems else "没有未解决的问题。")
    if feishu.send("\n".join(lines)):
        state["weekly_sent"] = stamp
        state["week"] = {"start": time.time(), "up": 0, "down": 0}


def main():
    config = load("config.json", None)
    if not config:
        sys.exit("config.json missing")
    state = load("state.json", {})
    feishu = Feishu(state)
    problems = Problems(state, feishu, config.get("title", "Writer"))
    if "--test" in sys.argv:
        ok = feishu.send(f"✅ {config.get('title', 'Writer')} 监控已启用：之后网站打不开、备份失败或磁盘不足会在这里提醒。")
        save("state.json", state)
        sys.exit(0 if ok else 1)
    check_sites(config, state, problems)
    check_lab(config, state, problems)
    check_disk(config, problems)
    problems.settle()
    prune_backups(config)
    weekly(config, state, feishu)
    save("state.json", state)


if __name__ == "__main__":
    main()
