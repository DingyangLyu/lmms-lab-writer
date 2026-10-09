/**
 * Live AI conversations: the relay between members' browsers and the agents on the server's
 * shared runner. The runner holds one socket (`/api/runner/agents`, the shared runner token);
 * a browser holds one per project (`/api/projects/:id/agents`, owners and editors only).
 *
 * The server keeps the conversation registry (who started each one, private or shared), runs
 * one AI turn per project at a time with a saved version before it, and merges the files the
 * agent changes into the shared text in the name of the member whose turn it is. Where a
 * collaborator changed the same lines meanwhile, the agent's version becomes a suggestion.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Locale } from "@lmms-lab/i18n";
import { mergeText, reviewHunks } from "@lmms-lab/writing";
import { WebSocket, WebSocketServer } from "ws";
import {
  type AgentBusy,
  type AgentChangeResult,
  type AgentEvent,
  type AgentFile,
  type AgentStatus,
  type AgentThread,
  CHANGES_EVENT,
  CLAUDE_EVENT,
  HARNESS_PERMISSIONS,
  THREADS_EVENT,
} from "../shared/agents";
import { allowedOrigin, bearer, userFor } from "./auth";
import type { Collaboration } from "./collaboration";
import { sql } from "./db";
import type { SharedRunner } from "./http";
import { requestLocale, say } from "./messages";
import { createFile, PROJECT_BYTES } from "./routes/files";
import type { Store, User } from "./store";
import { checked, decodeText, digest, fail, HttpError, isTextPath, safePath, uid } from "./util";

type Params = Record<string, unknown>;
type Browser = {
  socket: WebSocket;
  req: IncomingMessage;
  user: User;
  project: string;
  locale: Locale;
};
type Runner = { socket: WebSocket; status: AgentStatus; alive: boolean };
type Call = {
  runner: Runner;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Turn = { thread: string; user: string; userName: string; at: number };
type ThreadRow = {
  id: string;
  project: string;
  owner: string;
  harness: string;
  title: string;
  shared: boolean;
  updated: number;
};
/** A busy marker outlives a lost `turn/completed` by at most this long. */
const TURN_LIMIT = 3 * 3600_000;
const RUNNER_PATH = "/api/runner/agents";
const BROWSER_PATH = /^\/api\/projects\/([^/]+)\/agents$/;
const IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const send = (socket: WebSocket, message: unknown) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};
const isObject = (value: unknown): value is Params =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (params: Params, key: string, max = 200) =>
  typeof params[key] === "string" && params[key].length <= max
    ? (params[key] as string)
    : fail(400, "无效字段 {key}", { key });
const optional = (params: Params, key: string, max = 200) =>
  params[key] === undefined || params[key] === null || params[key] === ""
    ? null
    : text(params, key, max);
const threadId = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : fail(400, "无效对话");
const visible = (thread: ThreadRow, user: string) => thread.owner === user || thread.shared;
/** Where a harness's turn begins and ends in the events its runner sends. */
const turnMarker = (event: AgentEvent): "start" | "end" | null => {
  if (event.method === "turn/started") return "start";
  if (event.method === "turn/completed") return "end";
  if (event.method === CLAUDE_EVENT) {
    const type = (event.params?.event as { type?: string } | undefined)?.type;
    return type === "writer_started" ? "start" : type === "writer_done" ? "end" : null;
  }
  return null;
};
/** Data URLs of at most six images and 24 MB, as the desktop accepts them. */
function images(params: Params) {
  const value = params.images ?? [];
  if (!Array.isArray(value)) fail(400, "无效字段 {key}", { key: "images" });
  if (value.length > 6) fail(400, "一次最多发送 6 张图片");
  let total = 0;
  for (const url of value) {
    if (typeof url !== "string" || url.length > 14_000_000 || !IMAGE.test(url))
      fail(400, "图片格式或大小不正确");
    total += url.length;
  }
  if (total > 32_000_000) fail(413, "图片总大小超过 24 MB");
  return value as string[];
}

export class Agents {
  private browsers = new Set<Browser>();
  private runner: Runner | null = null;
  private calls = new Map<string, Call>();
  private turns = new Map<string, Turn>();
  private threads = new Map<string, ThreadRow>();
  /** Events keep their order; a registry lookup must not let a later delta overtake. */
  private events: Promise<void> = Promise.resolve();
  private browserServer = new WebSocketServer({ noServer: true, maxPayload: 40_000_000 });
  private runnerServer = new WebSocketServer({ noServer: true, maxPayload: 160_000_000 });
  private sweep: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    private collab: Collaboration,
    private origin: () => string,
    private shared?: SharedRunner,
  ) {
    this.sweep = setInterval(() => void this.check(), 30_000);
    this.sweep.unref();
  }
  /** Whether an upgrade request belongs to this relay rather than to document editing. */
  handles(req: IncomingMessage) {
    const path = new URL(req.url ?? "", "http://writer").pathname;
    return path === RUNNER_PATH || BROWSER_PATH.test(path);
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    void this.accept(req, socket, head).catch(() => {
      if (socket.writable) socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
  }
  status(): AgentStatus {
    return this.runner?.status ?? { online: false, name: null, harnesses: [], permissions: {} };
  }
  busy(project: string): AgentBusy {
    const turn = this.turns.get(project);
    if (turn && Date.now() - turn.at > TURN_LIMIT) this.turns.delete(project);
    const live = this.turns.get(project);
    return live ? { thread: live.thread, user: live.user, userName: live.userName } : null;
  }
  close() {
    clearInterval(this.sweep);
    for (const browser of this.browsers) browser.socket.terminate();
    if (this.runner) this.runner.socket.terminate();
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(new HttpError(503, "共享执行器已断开"));
    }
    this.calls.clear();
    this.browserServer.close();
    this.runnerServer.close();
  }

  private async accept(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "", this.origin());
    if (url.pathname === RUNNER_PATH) return this.acceptRunner(req, socket, head);
    if (!bearer(req) && !allowedOrigin(req.headers.origin, this.origin()))
      fail(403, "Origin 不匹配");
    const project = BROWSER_PATH.exec(url.pathname)?.[1] ?? fail(404, "连接不存在");
    const user = await userFor(this.store, req);
    if (user.mustChange) fail(403, "请先修改临时密码");
    await this.store.require(project, user.id, "edit");
    if ([...this.browsers].filter((b) => b.user.id === user.id).length >= 16)
      fail(429, "同时连接数量达到上限");
    const locale: Locale =
      url.searchParams.get("locale") === "en" ? "en" : requestLocale(req.headers);
    const socketOpen = await new Promise<WebSocket>((resolve) =>
      this.browserServer.handleUpgrade(req, socket, head, resolve),
    );
    const browser: Browser = { socket: socketOpen, req, user, project, locale };
    this.browsers.add(browser);
    socketOpen.on("message", (raw) => void this.fromBrowser(browser, raw.toString()));
    socketOpen.on("close", () => this.browsers.delete(browser));
    socketOpen.on("error", () => {});
    send(socketOpen, { status: this.status() });
    send(socketOpen, { busy: this.busy(project) });
  }
  /** The shared runner only; a newer connection replaces an older one (a restarted runner). */
  private async acceptRunner(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const token = bearer(req);
    if (
      !this.shared ||
      !token ||
      !timingSafeEqual(Buffer.from(digest(token)), Buffer.from(digest(this.shared.token)))
    )
      fail(401, "Runner 凭据无效");
    const name = this.shared.name;
    const socketOpen = await new Promise<WebSocket>((resolve) =>
      this.runnerServer.handleUpgrade(req, socket, head, resolve),
    );
    const previous = this.runner;
    const runner: Runner = {
      socket: socketOpen,
      status: { online: true, name, harnesses: [], permissions: {} },
      alive: true,
    };
    this.runner = runner;
    if (previous) {
      this.runnerGone(previous);
      previous.socket.close(1012);
    }
    socketOpen.on("message", (raw) => this.fromRunner(runner, raw.toString()));
    socketOpen.on("pong", () => {
      runner.alive = true;
    });
    socketOpen.on("close", () => this.runnerGone(runner));
    socketOpen.on("error", () => {});
  }
  private runnerGone(runner: Runner) {
    for (const [id, call] of this.calls)
      if (call.runner === runner) {
        clearTimeout(call.timer);
        this.calls.delete(id);
        call.reject(new HttpError(503, "共享执行器已断开"));
      }
    if (this.runner !== runner) return;
    this.runner = null;
    this.endAll();
  }
  /** The agents stopped (runner or app-server gone): no project is busy any more. */
  private endAll() {
    const busy = new Set(this.turns.keys());
    this.turns.clear();
    for (const b of this.browsers) {
      send(b.socket, { status: this.status() });
      send(b.socket, { event: { method: "codex/connectionClosed", params: {} } });
      if (busy.has(b.project)) send(b.socket, { busy: null });
    }
  }
  /** Re-check every browser's access, and drop a runner that stopped answering pings. */
  private async check() {
    const runner = this.runner;
    if (runner) {
      if (!runner.alive) runner.socket.terminate();
      else {
        runner.alive = false;
        runner.socket.ping();
      }
    }
    for (const browser of this.browsers)
      try {
        const user = await userFor(this.store, browser.req);
        await this.store.require(browser.project, user.id, "edit");
        browser.socket.ping();
      } catch {
        this.closeBrowser(browser);
      }
  }
  private closeBrowser(browser: Browser) {
    let reason = say(browser.locale, "登录或项目权限已失效");
    while (Buffer.byteLength(reason) > 123) reason = reason.slice(0, -1);
    browser.socket.close(1008, reason);
    this.browsers.delete(browser);
  }

  private call<T = unknown>(method: string, params: Params, timeout = 60_000): Promise<T> {
    const runner = this.runner ?? fail(503, "共享执行器未连接，AI 对话暂不可用");
    const id = uid();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new HttpError(504, "执行器没有响应"));
      }, timeout);
      this.calls.set(id, { runner, resolve: resolve as (value: unknown) => void, reject, timer });
      send(runner.socket, { id, method, params });
    });
  }
  private fromRunner(runner: Runner, raw: string) {
    if (this.runner !== runner) return;
    let message: Params;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) return;
      message = parsed;
    } catch {
      return;
    }
    if (isObject(message.status)) {
      const offered = message.status;
      const harnesses = (Array.isArray(offered.harnesses) ? offered.harnesses : []).filter(
        (h): h is string =>
          typeof h === "string" &&
          !!this.shared?.capabilities.includes(h) &&
          h in HARNESS_PERMISSIONS,
      );
      const permissions = isObject(offered.permissions) ? offered.permissions : {};
      runner.status = {
        online: true,
        name: runner.status.name,
        harnesses,
        permissions: Object.fromEntries(
          harnesses.map((h) => {
            const offeredModes = Array.isArray(permissions[h]) ? (permissions[h] as unknown[]) : [];
            return [h, (HARNESS_PERMISSIONS[h] ?? []).filter((p) => offeredModes.includes(p))];
          }),
        ),
      };
      for (const b of this.browsers) send(b.socket, { status: runner.status });
      return;
    }
    if (isObject(message.event)) {
      const event = message.event as AgentEvent,
        project = typeof message.project === "string" ? message.project : null;
      this.events = this.events
        .then(() => this.relay(event, project))
        .catch((error) => console.error("Writer agent event failed:", String(error)));
      return;
    }
    const id = typeof message.id === "string" ? message.id : null;
    if (!id) return;
    if (typeof message.method === "string") {
      const params = isObject(message.params) ? message.params : {};
      void this.runnerRequest(message.method, params).then(
        (result) => send(runner.socket, { id, result }),
        (error) =>
          send(runner.socket, {
            id,
            error:
              error instanceof HttpError
                ? say("en", error.template, error.params)
                : "Writer could not handle the request",
          }),
      );
      return;
    }
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    clearTimeout(call.timer);
    if (typeof message.error === "string")
      call.reject(new HttpError(502, "执行器：{error}", { error: message.error.slice(0, 2000) }));
    else call.resolve(message.result);
  }
  private async relay(event: AgentEvent, project: string | null) {
    if (event.method === "codex/connectionClosed") return this.endAll();
    const params = event.params;
    const id = typeof params?.threadId === "string" ? params.threadId : null;
    if (!id) return;
    const thread = await this.thread(id);
    if (!thread || (project && thread.project !== project)) return;
    const marker = turnMarker(event);
    if (marker === "start" && !this.turns.has(thread.project)) {
      const owner = await this.store.db.row<{ username: string }>(
        sql`SELECT username FROM users WHERE id=${thread.owner}`,
      );
      this.turns.set(thread.project, {
        thread: thread.id,
        user: thread.owner,
        userName: owner?.username ?? "",
        at: Date.now(),
      });
      this.announceBusy(thread.project);
    }
    if (marker === "end") {
      if (this.turns.get(thread.project)?.thread === thread.id) {
        this.turns.delete(thread.project);
        this.announceBusy(thread.project);
      }
      await this.touch(thread);
    }
    for (const b of this.browsers)
      if (b.project === thread.project && visible(thread, b.user.id)) send(b.socket, { event });
  }
  private async runnerRequest(method: string, params: Params) {
    const project = text(params, "project", 80);
    if (method === "files.read") {
      if (!this.turns.has(project)) fail(409, "这一轮已经结束");
      const paths = params.paths;
      if (!Array.isArray(paths) || paths.length > 50) fail(400, "无效字段 {key}", { key: "paths" });
      const files = [];
      for (const path of paths) {
        const row = await this.store.db.row<{ id: string; revision: number }>(
          sql`SELECT id, revision FROM files
              WHERE project=${project} AND path=${safePath(String(path))} AND is_binary AND NOT deleted`,
        );
        if (row)
          files.push({
            path,
            revision: row.revision,
            base64: Buffer.from(await this.store.fileState(row.id)).toString("base64"),
          });
      }
      return { files };
    }
    if (method === "changes") {
      const thread =
        (await this.thread(threadId(params.threadId))) ?? fail(404, "对话不存在或未共享");
      if (thread.project !== project) fail(404, "对话不存在或未共享");
      const turn = this.turns.get(project);
      // Normally the member whose turn it is; after a server restart, whoever started it.
      const actor = turn?.thread === thread.id ? turn.user : thread.owner;
      if (!(await this.store.can(project, actor, "edit"))) fail(403, "当前角色不允许此操作");
      const results = await this.applyChanges(project, actor, params.files);
      this.collab.changed(project);
      for (const b of this.browsers)
        if (b.project === project && visible(thread, b.user.id))
          send(b.socket, {
            event: {
              method: CHANGES_EVENT,
              params: {
                threadId: thread.id,
                results: results.map((r) =>
                  r.reason ? { ...r, reason: say(b.locale, r.reason) } : r,
                ),
              },
            },
          });
      return { results };
    }
    return fail(400, "未知消息");
  }

  private async fromBrowser(browser: Browser, raw: string) {
    let message: Params;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) return;
      message = parsed;
    } catch {
      return;
    }
    const id = typeof message.id === "string" && message.id.length <= 80 ? message.id : null;
    if (!id || typeof message.method !== "string") return;
    let user: User;
    try {
      user = await userFor(this.store, browser.req);
      await this.store.require(browser.project, user.id, "edit");
    } catch {
      return this.closeBrowser(browser);
    }
    try {
      const params = isObject(message.params) ? message.params : {};
      const result = await this.request(browser, user, message.method, params);
      send(browser.socket, { id, result: result ?? null });
    } catch (error) {
      if (!(error instanceof HttpError))
        console.error("Writer agent request failed:", error instanceof Error ? error.message : "");
      send(browser.socket, {
        id,
        error:
          error instanceof HttpError
            ? say(browser.locale, error.template, error.params)
            : say(browser.locale, "AI 对话操作失败"),
      });
    }
  }
  private async request(browser: Browser, user: User, method: string, params: Params) {
    const { project } = browser;
    switch (method) {
      case "codex.initialize":
        await this.call("codex.initialize", {});
        return { connected: true, webSearch: "live" };
      case "codex.models":
        return this.call("codex.models", {});
      case "codex.threads":
        return { data: await this.list(project, user.id, "codex") };
      case "codex.startThread": {
        const permissionMode = this.permission("codex", params);
        const result = await this.call<{ thread?: { id?: unknown } }>("codex.startThread", {
          project,
          model: optional(params, "model"),
          permissionMode,
        });
        await this.register(project, user, "codex", threadId(result?.thread?.id));
        return result;
      }
      case "codex.resume": {
        const thread = await this.access(project, user, params);
        return this.call("codex.resume", {
          project,
          threadId: thread.id,
          permissionMode: this.permission("codex", params),
        });
      }
      case "codex.read": {
        const thread = await this.access(project, user, params);
        return this.call("codex.read", { project, threadId: thread.id });
      }
      case "codex.startTurn":
        return this.startTurn(browser, user, "codex", params);
      case "claude.initialize":
        return this.call("claude.initialize", { project }, 60_000);
      case "claude.sessions":
        return (await this.list(project, user.id, "claude")).map((t) => this.session(t, project));
      case "claude.createSession": {
        const thread = await this.register(project, user, "claude", uid());
        return this.session(
          { ...thread, name: null, ownerName: user.username, mine: true },
          project,
        );
      }
      case "claude.read": {
        const thread = await this.access(project, user, params);
        const saved = await this.call<Params>("claude.read", { project, threadId: thread.id });
        const [summary] = (await this.list(project, user.id, "claude")).filter(
          (t) => t.id === thread.id,
        );
        return { ...saved, session: summary && this.session(summary, project) };
      }
      case "claude.rename": {
        const thread = await this.access(project, user, params);
        await this.rename(thread, user, params);
        return { ok: true };
      }
      case "claude.startTurn":
        return this.startTurn(browser, user, "claude", params);
      case "claude.steer": {
        const thread = await this.access(project, user, params);
        if (this.turns.get(project)?.thread !== thread.id) fail(409, "这一轮已经结束");
        const message = text(params, "text", 200_000),
          pictures = images(params);
        if (!message.trim() && !pictures.length) fail(400, "消息不能为空");
        return this.call("claude.steer", {
          project,
          threadId: thread.id,
          text: message,
          images: pictures,
        });
      }
      case "claude.respond": {
        const thread = await this.access(project, user, params);
        return this.call("claude.respond", {
          project,
          threadId: thread.id,
          requestId: text(params, "requestId"),
          allow: params.allow === true,
          answers: isObject(params.answers) ? params.answers : null,
        });
      }
      case "claude.stop": {
        const thread = await this.access(project, user, params);
        return this.call("claude.stop", { project, threadId: thread.id });
      }
      case "codex.steer": {
        const thread = await this.access(project, user, params);
        if (this.turns.get(project)?.thread !== thread.id) fail(409, "这一轮已经结束");
        const message = text(params, "text", 200_000),
          pictures = images(params);
        if (!message.trim() && !pictures.length) fail(400, "消息不能为空");
        return this.call("codex.steer", {
          project,
          threadId: thread.id,
          expectedTurnId: text(params, "expectedTurnId"),
          text: message,
          images: pictures,
        });
      }
      case "codex.interrupt": {
        const thread = await this.access(project, user, params);
        return this.call("codex.interrupt", {
          project,
          threadId: thread.id,
          turnId: text(params, "turnId"),
        });
      }
      case "codex.rename": {
        const thread = await this.access(project, user, params);
        await this.rename(thread, user, params);
        // Codex's own copy of the name is a convenience; the registry is what members see.
        if (this.runner)
          void this.call("codex.rename", {
            project,
            threadId: thread.id,
            name: thread.title,
          }).catch(() => {});
        return { ok: true };
      }
      case "codex.respond": {
        const thread = await this.access(project, user, params);
        const requestId = params.requestId;
        if (
          !(typeof requestId === "number" || typeof requestId === "string") ||
          !isObject(params.response)
        )
          fail(400, "无效字段 {key}", { key: "response" });
        return this.call("codex.respond", {
          project,
          threadId: thread.id,
          requestId,
          response: params.response,
        });
      }
      case "codex.pending": {
        const pending = await this.call<AgentEvent[]>("codex.pending", { project });
        const shown: AgentEvent[] = [];
        for (const request of Array.isArray(pending) ? pending : []) {
          const id = request?.params?.threadId;
          const thread = typeof id === "string" ? await this.thread(id) : null;
          if (thread?.project === project && visible(thread, user.id)) shown.push(request);
        }
        return shown;
      }
      case "thread.share": {
        const thread = await this.access(project, user, params);
        if (thread.owner !== user.id) fail(403, "只有对话的发起人可以重命名或共享");
        const shared = params.shared === true;
        await this.store.db.run(
          sql`UPDATE agent_threads SET shared=${shared} WHERE id=${thread.id}`,
        );
        thread.shared = shared;
        await this.store.audit(project, user.id, "agent.share", { thread: thread.id, shared });
        this.announceThreads(project);
        return { ok: true };
      }
      default:
        return fail(400, "未知消息");
    }
  }
  /**
   * One turn per project: the agent's working copy is the whole project. A version saved
   * first makes the turn revertible from History.
   */
  private async startTurn(browser: Browser, user: User, harness: string, params: Params) {
    const { project } = browser;
    const thread = await this.access(project, user, params);
    if (thread.harness !== harness) fail(404, "对话不存在或未共享");
    const options = isObject(params.options) ? params.options : params;
    const permissionMode = this.permission(harness, options);
    const message = text(params, "text", 200_000),
      pictures = images(params);
    if (!message.trim() && !pictures.length) fail(400, "消息不能为空");
    const model = optional(options, "model"),
      effort = optional(options, "effort", 40);
    const running = this.busy(project);
    if (running)
      fail(
        409,
        running.thread === thread.id
          ? "这个对话还在运行"
          : "{name} 的 AI 对话正在修改此项目，请等它完成",
        { name: running.userName },
      );
    if (!this.runner) fail(503, "共享执行器未连接，AI 对话暂不可用");
    // Claude Code sessions are named after their first message, as on the desktop.
    const firstLine = message
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (harness === "claude" && !thread.title && firstLine) {
      thread.title = [...firstLine].slice(0, 40).join("");
      await this.store.db.run(
        sql`UPDATE agent_threads SET title=${thread.title} WHERE id=${thread.id}`,
      );
      this.announceThreads(project);
    }
    const turn: Turn = {
      thread: thread.id,
      user: user.id,
      userName: user.username,
      at: Date.now(),
    };
    this.turns.set(project, turn);
    this.announceBusy(project);
    try {
      await this.store.snapshot(project, user.id, "AI 对话修改前");
      this.collab.changed(project);
      const result = await this.call(
        `${harness}.startTurn`,
        {
          project,
          threadId: thread.id,
          files: await this.files(project),
          text: message,
          images: pictures,
          model,
          effort,
          permissionMode,
        },
        180_000,
      );
      await this.touch(thread);
      return result;
    } catch (error) {
      if (this.turns.get(project) === turn) {
        this.turns.delete(project);
        this.announceBusy(project);
      }
      throw error;
    }
  }
  private permission(harness: string, params: Params): string {
    const value = params.permissionMode ?? (harness === "claude" ? "default" : "askForApproval");
    if (typeof value !== "string" || !HARNESS_PERMISSIONS[harness]?.includes(value))
      fail(400, "无效字段 {key}", { key: "permissionMode" });
    if (!this.status().permissions[harness]?.includes(value)) fail(400, "执行器不支持这种权限模式");
    return value;
  }
  /** A new conversation: private to whoever started it. */
  private async register(project: string, user: User, harness: string, id: string) {
    const now = Date.now();
    await this.store.db.run(
      sql`INSERT INTO agent_threads(id, project, owner, harness, title, shared, created, updated)
          VALUES(${id}, ${project}, ${user.id}, ${harness}, '', false, ${now}, ${now})`,
    );
    const thread: ThreadRow = {
      id,
      project,
      owner: user.id,
      harness,
      title: "",
      shared: false,
      updated: now,
    };
    this.threads.set(id, thread);
    await this.store.audit(project, user.id, "agent.start", { thread: id, harness });
    this.announceThreads(project);
    return thread;
  }
  private async rename(thread: ThreadRow, user: User, params: Params) {
    if (thread.owner !== user.id) fail(403, "只有对话的发起人可以重命名或共享");
    const name = text(params, "name", 1000).trim();
    if (!name || [...name].length > 120) fail(400, "对话名称需为 1–120 个字符");
    await this.store.db.run(sql`UPDATE agent_threads SET title=${name} WHERE id=${thread.id}`);
    thread.title = name;
    this.announceThreads(thread.project);
  }
  /** A Claude Code session as the panel lists it. */
  private session(
    thread: Pick<AgentThread, "id" | "name" | "updated" | "mine" | "shared" | "ownerName">,
    project: string,
  ) {
    return {
      id: thread.id,
      name: thread.name ?? "",
      directory: project,
      updatedAt: thread.updated,
      mine: thread.mine,
      shared: thread.shared,
      ownerName: thread.ownerName,
    };
  }
  private async thread(id: string): Promise<ThreadRow | null> {
    const cached = this.threads.get(id);
    if (cached) return cached;
    const row = await this.store.db.row<ThreadRow>(
      sql`SELECT id, project, owner, harness, title, shared, updated FROM agent_threads WHERE id=${id}`,
    );
    if (!row) return null;
    const thread = { ...row, shared: !!row.shared };
    if (this.threads.size > 5000) this.threads.clear();
    this.threads.set(id, thread);
    return thread;
  }
  private async access(project: string, user: User, params: Params) {
    const thread = await this.thread(threadId(params.threadId));
    if (!thread || thread.project !== project || !visible(thread, user.id))
      fail(404, "对话不存在或未共享");
    return thread;
  }
  private async touch(thread: ThreadRow) {
    thread.updated = Date.now();
    await this.store.db.run(
      sql`UPDATE agent_threads SET updated=${thread.updated} WHERE id=${thread.id}`,
    );
  }
  private async list(project: string, user: string, harness: string): Promise<AgentThread[]> {
    const rows = await this.store.db.rows<ThreadRow & { ownerName: string }>(
      sql`SELECT t.id, t.project, t.owner, t.harness, t.title, t.shared, t.updated, u.username AS "ownerName"
          FROM agent_threads t JOIN users u ON u.id=t.owner
          WHERE t.project=${project} AND t.harness=${harness} AND (t.owner=${user} OR t.shared)
          ORDER BY t.updated DESC LIMIT 200`,
    );
    return rows.map((r) => ({
      id: r.id,
      harness: r.harness,
      name: r.title || null,
      owner: r.owner,
      ownerName: r.ownerName,
      mine: r.owner === user,
      shared: !!r.shared,
      updated: Number(r.updated),
    }));
  }
  private announceThreads(project: string) {
    for (const b of this.browsers)
      if (b.project === project) send(b.socket, { event: { method: THREADS_EVENT, params: {} } });
  }
  private announceBusy(project: string) {
    const busy = this.busy(project);
    for (const b of this.browsers) if (b.project === project) send(b.socket, { busy });
  }
  /** The project as the runner's working copy needs it; binaries go by revision only. */
  private async files(project: string): Promise<AgentFile[]> {
    return (await this.store.projectFiles(project)).map((f) =>
      f.binary
        ? { path: f.path, binary: true, revision: f.revision }
        : { path: f.path, binary: false, revision: f.revision, content: decodeText(f.state) },
    );
  }

  /** Each change on its own: one that cannot be applied does not hold back the others. */
  private async applyChanges(project: string, actor: string, raw: unknown) {
    if (!Array.isArray(raw) || raw.length > 200) fail(400, "AI 改动无效");
    const results: AgentChangeResult[] = [];
    for (const value of raw) {
      if (!isObject(value)) fail(400, "AI 改动无效");
      const path = safePath(text(value, "path", 240));
      try {
        results.push(await this.applyChange(project, actor, path, value));
      } catch (error) {
        if (!(error instanceof HttpError) || error.status >= 500) throw error;
        results.push({ path, status: "skipped", reason: error.template });
      }
    }
    return results;
  }
  private async applyChange(
    project: string,
    actor: string,
    path: string,
    change: Params,
  ): Promise<AgentChangeResult> {
    const file = await this.store.db.row<{ id: string; binary: boolean; revision: number }>(
      sql`SELECT id, is_binary AS "binary", revision FROM files
          WHERE project=${project} AND path=${path} AND NOT deleted`,
    );
    const base = typeof change.base === "string" ? change.base : null;
    const revision = typeof change.revision === "number" ? change.revision : null;
    if (change.deleted === true) {
      if (!file) return { path, status: "applied" };
      const unchanged = file.binary
        ? revision === file.revision
        : (await this.collab.text(project, file.id)) === base;
      // Someone else's newer work is never deleted.
      if (!unchanged) return { path, status: "skipped", reason: "文件已被其他人修改，未删除" };
      await this.store.db.transaction(async (tx) => {
        await tx.run(sql`UPDATE files SET deleted=true WHERE id=${file.id}`);
        await this.store.audit(
          project,
          actor,
          "file.delete",
          { file: file.id, path, agent: true },
          tx,
        );
      });
      this.collab.closeFile(file.id, "文件已删除");
      return { path, status: "applied" };
    }
    if (typeof change.content === "string") {
      if (!isTextPath(path) || file?.binary)
        return { path, status: "skipped", reason: "文件类型已改变" };
      if (Buffer.byteLength(change.content) > 2_000_000) fail(413, "文本文件超过 2 MB");
      if (!file) {
        await createFile(this.store, project, actor, path, change.content);
        return { path, status: "applied" };
      }
      // A collaborator may type between reading and replacing; try again with the new text.
      for (let attempt = 0; ; attempt++) {
        const current = await this.collab.text(project, file.id);
        const merged = mergeText(base ?? "", current, change.content);
        if (merged.content === null) {
          await this.propose(project, file.id, actor, base ?? "", change.content);
          return { path, status: "proposal" };
        }
        if (merged.content === current) return { path, status: "applied" };
        try {
          await this.collab.replaceMany(
            project,
            [{ file: file.id, expected: current, content: merged.content }],
            actor,
          );
          return { path, status: "applied" };
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 409 || attempt >= 2) throw error;
        }
      }
    }
    if (typeof change.base64 === "string") {
      if (isTextPath(path) || (file && !file.binary))
        return { path, status: "skipped", reason: "文件类型已改变" };
      if (change.base64.length > 14_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(change.base64))
        fail(400, "无效文件编码");
      const bytes = Buffer.from(change.base64, "base64");
      if (bytes.length > 10_000_000) fail(413, "单文件超过 10 MB");
      if (!file) {
        const created = await createFile(this.store, project, actor, path, bytes);
        return { path, status: "applied", revision: created.revision };
      }
      if (revision !== file.revision)
        return { path, status: "skipped", reason: "文件已被其他人替换" };
      const saved = await this.store.db.transaction(async (tx) => {
        const size = await tx.row<{ bytes: number }>(
          sql`SELECT coalesce(sum(length(state)),0) AS bytes FROM files WHERE project=${project} AND id<>${file.id}`,
        );
        if ((size?.bytes ?? 0) + bytes.length > PROJECT_BYTES) fail(413, "项目超过 100 MB");
        const row =
          (await tx.row<{ revision: number }>(
            sql`UPDATE files SET state=${bytes}, revision=revision+1
                WHERE id=${file.id} AND revision=${file.revision} AND NOT deleted RETURNING revision`,
          )) ?? fail(409, "文件已被其他人替换");
        await this.store.audit(
          project,
          actor,
          "file.replace",
          { file: file.id, path, agent: true },
          tx,
        );
        return row.revision;
      });
      return { path, status: "applied", revision: saved };
    }
    return fail(400, "AI 改动无效");
  }
  /** Overlapping edits stay reviewable hunk by hunk, as a member's suggestion would. */
  private async propose(
    project: string,
    file: string,
    actor: string,
    base: string,
    proposed: string,
  ) {
    const id = uid(),
      hunks = checked(() => reviewHunks(base, proposed));
    await this.store.db.transaction(async (tx) => {
      await tx.run(
        sql`INSERT INTO proposals(id, project, file, author, base, proposed, hunks, revision, created)
            VALUES(${id}, ${project}, ${file}, ${actor}, ${base}, ${proposed}, ${JSON.stringify(hunks)}, 1, ${Date.now()})`,
      );
      await this.store.audit(project, actor, "proposal.create", { id, file, agent: true }, tx);
    });
  }
}
