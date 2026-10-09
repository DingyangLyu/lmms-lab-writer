/**
 * The shared runner's side of live AI conversations (see agents.ts for the server's side).
 * One Codex app-server serves every project; each project has its own working folder, which
 * is brought up to date with the server before every turn. What the agent changes goes back
 * to the server after each step and before the turn is reported finished; the server merges
 * it into the shared text. The working folder is a disposable copy: the server is the record.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { validPath } from "@lmms-lab/sync";
import { WebSocket } from "ws";
import {
  AGENT_PERMISSIONS,
  type AgentChange,
  type AgentChangeResult,
  type AgentFile,
  type AgentPermission,
  CLAUDE_EVENT,
  CLAUDE_PERMISSIONS,
  type ClaudePermission,
  OPENCODE_EVENT,
} from "../shared/agents";
import { isTextPath } from "./util";

type Json = Record<string, unknown>;
type Workspace = {
  dir: string;
  /** Text of every project text file as the server last had it from this copy. */
  text: Map<string, string>;
  binary: Map<string, { revision: number; hash: string }>;
  /** The conversation whose turn is running here. */
  thread: string | null;
  /** Pushes and event delivery for one project run in order. */
  queue: Promise<unknown>;
};
export type AgentHostOptions = {
  server: string;
  token: string;
  /** Parent of the per-project working folders. */
  root?: string;
  /** Where Claude Code transcripts are kept (the CLI keeps its own context too). */
  sessions?: string;
  /** The harnesses this runner hosts; Codex unless configured otherwise. */
  harnesses?: string[];
  codex?: string;
  claude?: string;
  opencode?: string;
  permissions?: AgentPermission[];
  claudePermissions?: ClaudePermission[];
  log?: (message: string) => void;
};
/** One Claude Code turn: a stream-json CLI process for the session. */
type ClaudeRun = {
  pending: Map<string, Json>;
  busy: boolean;
  delivery: { accepting: boolean; initialized: boolean; outstanding: number };
  send: (message: Json) => void;
  kill: () => void;
};
const CLAUDE_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-prompt-tool",
  "stdio",
];
const CLAUDE_PROMPT =
  "You are working in Y-Writer on a copy of a shared LaTeX project kept by the lab's runner. After each tool step, the files you change here are merged into your collaborators' live text, and the project was saved as a version before this turn. Follow the user's requested scope and preserve unrelated changes. Verify citations against primary sources and never invent bibliographic details. Do not commit, push or publish anything, and do not read credentials or files outside this folder. Link project files with relative Markdown links and line numbers when useful.";
const CLAUDE_INIT = {
  type: "control_request",
  request_id: "writer-init",
  request: { subtype: "initialize" },
};
/** Claude Code's content for a message: its text, and images as base64 sources. */
export function claudeInput(text: string, images: string[]): Json {
  const content: Json[] = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const url of images) {
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
    if (match)
      content.push({
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] },
      });
  }
  return {
    type: "user",
    session_id: "",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  };
}
/** The CLI's permission flags; skipping approvals must be asked for explicitly. */
const claudePermissionArgs = (mode: ClaudePermission) =>
  mode === "bypassPermissions"
    ? ["--permission-mode", mode, "--dangerously-skip-permissions"]
    : ["--permission-mode", mode];
/** The agents run collaborators' prompts: they get none of Writer's tokens or passwords. */
function agentEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^WRITER_.*(TOKEN|PASSWORD|DATABASE_URL)/.test(key)) delete env[key];
  return env;
}
/** The OpenCode calls the web panel makes (the server checks who may make them). */
const OPENCODE_CALLS: Array<[string, RegExp]> = [
  ["GET", /^\/session$/],
  ["POST", /^\/session$/],
  ["GET", /^\/session\/status$/],
  ["GET", /^\/session\/[^/]+$/],
  ["PATCH", /^\/session\/[^/]+$/],
  ["DELETE", /^\/session\/[^/]+$/],
  ["GET", /^\/session\/[^/]+\/message$/],
  ["GET", /^\/session\/[^/]+\/message\/[^/]+\/part$/],
  ["POST", /^\/session\/[^/]+\/abort$/],
  ["POST", /^\/question\/[^/]+\/reply$/],
  ["GET", /^\/(config|agent|provider)$/],
];
/** Collaborators' prompts may edit the project; shell and other folders stay off unless configured. */
const OPENCODE_PERMISSION = JSON.stringify({
  external_directory: "deny",
  bash: "deny",
  edit: "allow",
  read: "allow",
  webfetch: "allow",
});
const OPENCODE_CONTEXT =
  "Y-Writer shared project on the lab's runner: after each step the files you change here are merged into your collaborators' live text, and a version was saved before this turn. Edit only what the task needs; do not commit, push or publish anything.";
/** What the panel needs from OpenCode's settings, without provider options or keys. */
export function openCodeSettings(path: string, body: string) {
  const data = JSON.parse(body) as Json;
  if (path === "/config") return { model: data.model, default_agent: data.default_agent };
  if (path === "/agent")
    return (Array.isArray(data) ? data : Object.values(data)).map((raw) => {
      const agent = (raw ?? {}) as Json;
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
        hidden: agent.hidden,
      };
    });
  const all = Array.isArray(data.all) ? (data.all as Json[]) : [];
  return {
    connected: Array.isArray(data.connected) ? data.connected : [],
    all: all.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: Object.fromEntries(
        Object.entries((provider.models ?? {}) as Record<string, Json>).map(([key, model]) => {
          const capabilities = model.capabilities as { input?: { image?: boolean } } | undefined;
          const options = (model.options ?? {}) as Json;
          const variants = (model.variants ?? {}) as Record<string, Json>;
          return [
            key,
            {
              id: model.id,
              name: model.name,
              capabilities: { input: { image: capabilities?.input?.image } },
              options: { max: options.max, reasoning: options.reasoning },
              variants: Object.fromEntries(
                Object.entries(variants).map(([name, v]) => [name, { disabled: v?.disabled }]),
              ),
            },
          ];
        }),
      ),
    })),
  };
}
/**
 * `opencode serve` does not exit with the runner (it reads no stdin), so a killed runner can
 * leave one behind; the next runner stops it, if that process is still OpenCode.
 */
async function stopStaleOpenCode(pidFile: string) {
  const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  const command = await new Promise<string>((resolve) => {
    const probe =
      process.platform === "win32"
        ? spawn("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true })
        : spawn("ps", ["-o", "command=", "-p", String(pid)]);
    let out = "";
    probe.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    probe.on("close", () => resolve(out));
    probe.on("error", () => resolve(""));
  });
  if (/opencode/i.test(command))
    try {
      process.kill(pid);
    } catch {}
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        address && typeof address === "object"
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
/** Starts a CLI in its own process group (Unix), so stopping it stops its tools too. */
function spawnAgent(binary: string, args: string[], cwd: string) {
  const child = spawn(binary, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: agentEnv(),
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const kill = (signal: NodeJS.Signals = "SIGTERM") => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {}
  };
  return { child, kill };
}

/** Codex's composer choices as app-server policies, exactly as the desktop sends them. */
const POLICIES: Record<
  AgentPermission,
  { approvalPolicy: string; approvalsReviewer: string; sandbox: string; sandboxPolicy: Json }
> = {
  readOnly: {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "read-only",
    sandboxPolicy: { type: "readOnly" },
  },
  askForApproval: {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    sandboxPolicy: { type: "workspaceWrite" },
  },
  autoReview: {
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
    sandboxPolicy: { type: "workspaceWrite" },
  },
  fullAccess: {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
    sandboxPolicy: { type: "dangerFullAccess" },
  },
};
const threadPolicy = (mode: AgentPermission) => {
  const { approvalPolicy, approvalsReviewer, sandbox } = POLICIES[mode];
  return { approvalPolicy, approvalsReviewer, sandbox };
};
const turnPolicy = (mode: AgentPermission) => {
  const { approvalPolicy, approvalsReviewer, sandboxPolicy } = POLICIES[mode];
  return { approvalPolicy, approvalsReviewer, sandboxPolicy };
};
/** One line, so the shared chat view hides it like the desktop's own conversation context. */
const CONTEXT =
  "You are working in a copy of a shared Y-Writer project on the lab's runner. After each step, the files you change here are merged into your collaborators' live text, and the project was saved as a version before this turn. Edit only what the task needs; do not commit, push or publish anything, and do not read credentials or files outside this folder.";
/** Folders that hold tools' output rather than the paper. */
const SKIPPED = new Set(["node_modules", "__pycache__", "build", "build-output", "dist", "target"]);
/** Figures an agent may create; other binary files only travel when the project has them. */
const NEW_BINARY = /\.(png|jpe?g|gif|svg|pdf|eps)$/i;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const local = (dir: string, path: string) => {
  if (!validPath(path)) throw new Error(`Invalid project path: ${path}`);
  return join(dir, ...path.split("/"));
};

export function defaultPermissions(): AgentPermission[] {
  const configured = process.env.WRITER_CODEX_PERMISSIONS?.split(",").map((p) => p.trim());
  if (configured?.length) return AGENT_PERMISSIONS.filter((p) => configured.includes(p));
  // Where Codex's sandbox cannot run (a Windows service account), only full access works.
  return process.env.WRITER_CODEX_SANDBOX === "danger-full-access"
    ? ["fullAccess"]
    : [...AGENT_PERMISSIONS];
}

/** The answers Codex accepts for each kind of approval request (as the desktop checks them). */
export function validResponse(method: string, response: Json) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return ["accept", "acceptForSession", "decline", "cancel"].includes(
        String(response.decision),
      );
    case "mcpServer/elicitation/request":
      return ["accept", "decline", "cancel"].includes(String(response.action));
    case "item/tool/requestUserInput":
      return !!response.answers && typeof response.answers === "object";
    case "item/permissions/requestApproval":
      return !!response.permissions && typeof response.permissions === "object";
    case "item/tool/call":
      return typeof response.success === "boolean" && Array.isArray(response.contentItems);
    default:
      return true;
  }
}

/** A Codex app-server over stdio: JSON-RPC requests, its notifications and its own requests. */
class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  /** Approval requests waiting for an answer, by their JSON id. */
  readonly requests = new Map<string, Json>();
  closed = false;
  constructor(
    binary: string,
    private onMessage: (message: Json) => void,
    private onClose: () => void,
  ) {
    this.child = spawn(binary, ["-c", 'web_search="live"', "app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: agentEnv(),
      windowsHide: true,
    });
    this.child.stderr.resume();
    this.child.on("error", () => this.close());
    this.child.on("exit", () => this.close());
    createInterface({ input: this.child.stdout }).on("line", (line) => this.line(line));
  }
  async start() {
    await this.request("initialize", {
      clientInfo: { name: "lmms_lab_writer", title: "Y-Writer", version: "web" },
    });
    this.write({ method: "initialized", params: {} });
    return this;
  }
  request(method: string, params: Json, timeout = 120_000): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.next++;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not answer ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ id, method, params });
    });
  }
  respond(id: unknown, result: Json) {
    this.write({ id, result });
  }
  stop() {
    this.child.kill();
    this.close();
  }
  private write(message: Json) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private line(line: string) {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    if (typeof message.id === "number" && message.method === undefined) {
      const call = this.pending.get(message.id);
      this.pending.delete(message.id);
      const error = message.error as { message?: string } | undefined;
      if (error) call?.reject(new Error(error.message || "Codex returned an unknown error"));
      else call?.resolve((message.result ?? {}) as Json);
      return;
    }
    const params = (message.params ?? {}) as Json;
    if (message.method === "serverRequest/resolved")
      this.requests.delete(JSON.stringify(params.requestId));
    else if (message.id !== undefined && typeof message.method === "string")
      this.requests.set(JSON.stringify(message.id), message);
    this.onMessage(message);
  }
  private close() {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.pending.values()) call.reject(new Error("Codex app-server stopped"));
    this.pending.clear();
    this.requests.clear();
    this.onClose();
  }
}

export class AgentHost {
  private socket: WebSocket | null = null;
  private codex: AppServer | null = null;
  private starting: Promise<AppServer> | null = null;
  private workspaces = new Map<string, Workspace>();
  private threadProject = new Map<string, string>();
  /** Conversations the running app-server has loaded (started or resumed). */
  private loaded = new Set<string>();
  private calls = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private retry = 1000;
  private stopped = false;
  private failure = "";
  readonly root: string;
  readonly permissions: AgentPermission[];
  private log: (message: string) => void;
  readonly sessions: string;
  readonly harnesses: string[];
  readonly claudePermissions: ClaudePermission[];
  private claudeRuns = new Map<string, ClaudeRun>();
  private opencode: { port: number; kill: () => void; alive: boolean } | null = null;
  private opencodeStarting: Promise<{ port: number }> | null = null;
  private opencodeStreams = new Map<string, AbortController>();
  private claudeCatalog: { at: number; value: Json } | null = null;
  constructor(private options: AgentHostOptions) {
    this.root =
      options.root ||
      process.env.WRITER_AGENT_WORKSPACES ||
      join(homedir(), ".writer-runner", "projects");
    this.sessions = options.sessions || join(dirname(this.root), "claude-sessions");
    this.harnesses = (options.harnesses ?? ["codex"]).filter((h) =>
      ["codex", "claude", "opencode"].includes(h),
    );
    this.permissions = options.permissions ?? defaultPermissions();
    const claudeModes = process.env.WRITER_CLAUDE_PERMISSIONS?.split(",").map((p) => p.trim());
    this.claudePermissions =
      options.claudePermissions ??
      CLAUDE_PERMISSIONS.filter((p) => !claudeModes?.length || claudeModes.includes(p));
    this.log = options.log ?? ((message) => console.log(message));
  }
  start() {
    this.connect();
    return this;
  }
  stop() {
    this.stopped = true;
    this.socket?.close();
    this.codex?.stop();
    for (const stream of this.opencodeStreams.values()) stream.abort();
    this.opencode?.kill();
  }

  private connect() {
    if (this.stopped) return;
    const url = `${this.options.server.replace(/^http/, "ws")}/api/runner/agents`;
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      maxPayload: 200_000_000,
    });
    socket.on("open", () => {
      this.socket = socket;
      this.retry = 1000;
      this.failure = "";
      this.log(
        `Writer AI conversations connected: ${this.harnesses.join(", ")} (Codex: ${this.permissions.join(",")})`,
      );
      this.send({
        status: {
          harnesses: this.harnesses,
          permissions: { codex: this.permissions, claude: this.claudePermissions, opencode: [] },
        },
      });
    });
    socket.on("message", (raw) => this.fromServer(String(raw)));
    socket.on("error", (error) => {
      // Repeated failures (a wrong token, the server restarting) are logged once.
      if (error.message !== this.failure) this.log(`Writer AI conversations: ${error.message}`);
      this.failure = error.message;
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      for (const call of this.calls.values()) call.reject(new Error("Writer server disconnected"));
      this.calls.clear();
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.retry).unref();
      this.retry = Math.min(this.retry * 2, 60_000);
    });
  }
  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private server(method: string, params: Json, timeout = 300_000): Promise<Json> {
    if (!this.socket) return Promise.reject(new Error("Writer server disconnected"));
    const id = randomUUID();
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`Writer server did not answer ${method}`));
      }, timeout);
      this.calls.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ id, method, params });
    });
  }
  private fromServer(raw: string) {
    let message: Json;
    try {
      message = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    const id = typeof message.id === "string" ? message.id : null;
    if (!id) return;
    if (typeof message.method === "string") {
      const params = (message.params ?? {}) as Json;
      void this.handle(message.method, params).then(
        (result) => this.send({ id, result: result ?? null }),
        (error) => this.send({ id, error: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
    const call = this.calls.get(id);
    this.calls.delete(id);
    if (typeof message.error === "string") call?.reject(new Error(message.error));
    else call?.resolve((message.result ?? {}) as Json);
  }

  private ensure(): Promise<AppServer> {
    if (this.codex && !this.codex.closed) return Promise.resolve(this.codex);
    this.starting ??= (async () => {
      const binary = this.options.codex || process.env.WRITER_CODEX_BIN || "codex";
      const codex = new AppServer(
        binary,
        (message) => this.fromCodex(message),
        () => {
          if (this.codex === codex) this.codex = null;
          this.loaded.clear();
          for (const workspace of this.workspaces.values()) workspace.thread = null;
          this.send({ event: { method: "codex/connectionClosed", params: {} } });
        },
      );
      try {
        this.codex = await codex.start();
        return codex;
      } catch (error) {
        codex.stop();
        throw error;
      }
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  private workspace(project: string): Workspace {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(project)) throw new Error("Invalid project");
    let workspace = this.workspaces.get(project);
    if (!workspace) {
      workspace = {
        dir: join(this.root, project),
        text: new Map(),
        binary: new Map(),
        thread: null,
        queue: Promise.resolve(),
      };
      this.workspaces.set(project, workspace);
    }
    return workspace;
  }
  private permission(value: unknown): AgentPermission {
    if (!this.permissions.includes(value as AgentPermission))
      throw new Error("This runner does not support that permission mode");
    return value as AgentPermission;
  }
  private input(text: unknown, images: unknown, threadId?: string) {
    const body = typeof text === "string" ? text : "";
    const pictures = Array.isArray(images) ? images.filter((i) => typeof i === "string") : [];
    const message = threadId
      ? `[Writer conversation ID: codex:${threadId}]\n${CONTEXT}\n\n${body}`
      : body;
    return [
      ...(body.trim() || threadId ? [{ type: "text", text: message }] : []),
      ...pictures.map((url) => ({ type: "image", url })),
    ];
  }
  private async handle(method: string, params: Json): Promise<unknown> {
    const project = typeof params.project === "string" ? params.project : "";
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    switch (method) {
      case "codex.initialize":
        await this.ensure();
        return { connected: true };
      case "codex.models":
        return (await this.ensure()).request("model/list", { limit: 100 });
      case "codex.startThread": {
        const workspace = this.workspace(project);
        await mkdir(workspace.dir, { recursive: true });
        const codex = await this.ensure();
        let model = typeof params.model === "string" && params.model ? params.model : "";
        if (!model) {
          // The account's live catalog, not a possibly stale global preference.
          const catalog = await codex.request("model/list", { limit: 100 });
          const models = (catalog.data ?? []) as Array<{
            model?: string;
            id?: string;
            isDefault?: boolean;
          }>;
          const chosen = models.find((m) => m.isDefault) ?? models[0];
          model = chosen?.model ?? chosen?.id ?? "";
          if (!model) throw new Error("Codex returned no model catalog");
        }
        const result = await codex.request("thread/start", {
          cwd: workspace.dir,
          model,
          serviceName: "lmms_lab_writer",
          ...threadPolicy(this.permission(params.permissionMode)),
        });
        const id = (result.thread as { id?: string } | undefined)?.id;
        if (id) {
          this.threadProject.set(id, project);
          this.loaded.add(id);
        }
        return result;
      }
      case "codex.resume": {
        const workspace = this.workspace(project);
        await mkdir(workspace.dir, { recursive: true });
        const result = await (await this.ensure()).request("thread/resume", {
          threadId,
          ...threadPolicy(this.permission(params.permissionMode)),
        });
        this.threadProject.set(threadId, project);
        this.loaded.add(threadId);
        return result;
      }
      case "codex.read":
        this.threadProject.set(threadId, project);
        return (await this.ensure()).request("thread/read", { threadId, includeTurns: true });
      case "codex.startTurn":
        return this.startTurn(project, threadId, params);
      case "codex.steer":
        return (await this.ensure()).request("turn/steer", {
          threadId,
          expectedTurnId: params.expectedTurnId,
          input: this.input(params.text, params.images),
          clientUserMessageId: randomUUID(),
        });
      case "codex.interrupt":
        return (await this.ensure()).request("turn/interrupt", {
          threadId,
          turnId: params.turnId,
        });
      case "codex.rename":
        return (await this.ensure()).request("thread/name/set", { threadId, name: params.name });
      case "codex.respond": {
        const codex = await this.ensure();
        const key = JSON.stringify(params.requestId);
        const request = codex.requests.get(key);
        const response = (params.response ?? {}) as Json;
        if (!request || (request.params as Json | undefined)?.threadId !== threadId)
          throw new Error("This Codex request is no longer pending");
        if (!validResponse(String(request.method), response))
          throw new Error(`Invalid Codex response to ${String(request.method)}`);
        codex.requests.delete(key);
        codex.respond(request.id, response);
        return { ok: true };
      }
      case "codex.pending":
        return [...(this.codex?.requests.values() ?? [])].filter((request) => {
          const id = (request.params as Json | undefined)?.threadId;
          return typeof id === "string" && this.threadProject.get(id) === project;
        });
      case "opencode.fetch":
        return this.opencodeFetch(project, params);
      case "opencode.prompt":
        return this.opencodePrompt(project, threadId, params);
      case "claude.initialize":
        return this.claudeModels(project);
      case "claude.read":
        return this.claudeRead(project, threadId);
      case "claude.startTurn":
        return this.claudeTurn(project, threadId, params);
      case "claude.steer":
        return this.claudeSteer(project, threadId, params);
      case "claude.respond":
        return this.claudeRespond(threadId, params);
      case "claude.stop": {
        const run = this.claudeRuns.get(threadId);
        if (!run) throw new Error("The Claude conversation has ended");
        run.delivery.accepting = false;
        run.send({
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "interrupt" },
        });
        setTimeout(() => {
          if (run.busy) run.kill();
        }, 3000).unref();
        return { ok: true };
      }
      default:
        throw new Error(`Unknown request ${method}`);
    }
  }
  private async startTurn(project: string, threadId: string, params: Json) {
    const workspace = this.workspace(project);
    if (workspace.thread) throw new Error("Another AI turn is still running in this project");
    const mode = this.permission(params.permissionMode);
    workspace.thread = threadId;
    try {
      await this.sync(project, workspace, (params.files ?? []) as AgentFile[]);
      const codex = await this.ensure();
      this.threadProject.set(threadId, project);
      if (!this.loaded.has(threadId)) {
        await codex.request("thread/resume", { threadId, ...threadPolicy(mode) });
        this.loaded.add(threadId);
      }
      return await codex.request("turn/start", {
        threadId,
        input: this.input(params.text, params.images, threadId),
        ...(typeof params.model === "string" && params.model ? { model: params.model } : {}),
        ...(typeof params.effort === "string" && params.effort ? { effort: params.effort } : {}),
        ...turnPolicy(mode),
      });
    } catch (error) {
      workspace.thread = null;
      throw error;
    }
  }
  /**
   * Make the working copy match the server: text written where it differs, binaries fetched
   * where the copy is missing or outdated, and files the project no longer has removed.
   */
  async sync(project: string, workspace: Workspace, files: AgentFile[]) {
    await mkdir(workspace.dir, { recursive: true });
    const listed = new Set(files.map((f) => f.path));
    for (const path of await this.walk(workspace.dir))
      if (
        !listed.has(path) &&
        (isTextPath(path) || workspace.binary.has(path) || NEW_BINARY.test(path))
      )
        await rm(local(workspace.dir, path), { force: true });
    workspace.text.clear();
    const fetch: string[] = [];
    for (const file of files) {
      const path = local(workspace.dir, file.path);
      if (!file.binary) {
        const content = file.content ?? "";
        const current = await readFile(path, "utf8").catch(() => null);
        if (current !== content) {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content);
        }
        workspace.text.set(file.path, content);
        continue;
      }
      const known = workspace.binary.get(file.path);
      const current = await readFile(path).catch(() => null);
      if (!known || known.revision !== file.revision || !current || sha(current) !== known.hash)
        fetch.push(file.path);
    }
    for (const path of [...workspace.binary.keys()])
      if (!listed.has(path)) workspace.binary.delete(path);
    for (let i = 0; i < fetch.length; i += 8) {
      const { files: fetched } = (await this.server("files.read", {
        project,
        paths: fetch.slice(i, i + 8),
      })) as { files?: Array<{ path: string; revision: number; base64: string }> };
      for (const file of fetched ?? []) {
        const bytes = Buffer.from(file.base64, "base64"),
          path = local(workspace.dir, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
        workspace.binary.set(file.path, { revision: file.revision, hash: sha(bytes) });
      }
    }
  }
  /** Project paths in the working copy, without hidden files, tool output or links. */
  private async walk(dir: string, prefix = "", found: string[] = []) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      if (found.length >= 5000) break;
      if (entry.name.startsWith(".") || SKIPPED.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (path.split("/").length < 12) await this.walk(join(dir, entry.name), path, found);
      } else if (entry.isFile() && validPath(path)) found.push(path);
    }
    return found;
  }
  /** What differs from what the server last had from this copy. */
  async changes(workspace: Workspace): Promise<AgentChange[]> {
    const changes: AgentChange[] = [];
    const paths = await this.walk(workspace.dir);
    const present = new Set(paths);
    const stems = new Set(paths.filter((p) => p.endsWith(".tex")).map((p) => p.slice(0, -4)));
    for (const path of paths) {
      const full = local(workspace.dir, path);
      if (isTextPath(path)) {
        if ((await stat(full)).size > 2_000_000) continue;
        const content = await readFile(full, "utf8");
        const base = workspace.text.get(path);
        if (base !== content) changes.push({ path, base: base ?? null, content });
        continue;
      }
      const known = workspace.binary.get(path);
      // A compiled PDF beside its source is output, not a figure.
      if (
        !known &&
        (!NEW_BINARY.test(path) || (/\.pdf$/i.test(path) && stems.has(path.slice(0, -4))))
      )
        continue;
      if ((await stat(full)).size > 10_000_000) continue;
      const bytes = await readFile(full);
      if (known?.hash === sha(bytes)) continue;
      changes.push({
        path,
        base: null,
        ...(known ? { revision: known.revision } : {}),
        base64: bytes.toString("base64"),
      });
    }
    for (const [path, base] of workspace.text)
      if (!present.has(path)) changes.push({ path, base, deleted: true });
    for (const [path, known] of workspace.binary)
      if (!present.has(path))
        changes.push({ path, base: null, revision: known.revision, deleted: true });
    return changes;
  }
  /** Send the copy's changes to the server and take the result as the new baseline. */
  private async push(project: string, workspace: Workspace, threadId: string) {
    const changes = await this.changes(workspace);
    let batch: AgentChange[] = [],
      size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const sent = batch;
      batch = [];
      size = 0;
      const { results } = (await this.server("changes", { project, threadId, files: sent })) as {
        results?: AgentChangeResult[];
      };
      for (const result of results ?? []) {
        const change = sent.find((c) => c.path === result.path);
        if (!change) continue;
        if (change.deleted) {
          workspace.text.delete(change.path);
          workspace.binary.delete(change.path);
        } else if (change.content !== undefined) workspace.text.set(change.path, change.content);
        else if (change.base64 !== undefined)
          workspace.binary.set(change.path, {
            revision: result.revision ?? change.revision ?? 0,
            hash: sha(Buffer.from(change.base64, "base64")),
          });
      }
    };
    for (const change of changes) {
      const bytes = (change.content?.length ?? 0) + (change.base64?.length ?? 0);
      if (batch.length >= 100 || (batch.length && size + bytes > 24_000_000)) await flush();
      batch.push(change);
      size += bytes;
    }
    await flush();
  }
  /** One `opencode serve` for every project; requests name the project's folder. */
  private ensureOpenCode(): Promise<{ port: number }> {
    if (this.opencode?.alive) return Promise.resolve(this.opencode);
    this.opencodeStarting ??= (async () => {
      await mkdir(this.root, { recursive: true });
      const pidFile = join(dirname(this.root), "opencode.pid");
      await stopStaleOpenCode(pidFile);
      const port = await freePort();
      const binary = this.options.opencode || process.env.WRITER_OPENCODE_BIN || "opencode";
      const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: this.root,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        env: {
          ...agentEnv(),
          OPENCODE_ENABLE_EXA: "1",
          OPENCODE_PERMISSION: process.env.WRITER_OPENCODE_PERMISSION || OPENCODE_PERMISSION,
        },
      });
      if (child.pid) await writeFile(pidFile, String(child.pid)).catch(() => {});
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-2000);
      });
      const server = {
        port,
        alive: true,
        kill: () => {
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
            else child.kill();
          } catch {}
        },
      };
      const gone = () => {
        server.alive = false;
        if (this.opencode === server) this.opencode = null;
      };
      child.on("exit", gone);
      child.on("error", gone);
      for (let i = 0; i < 60 && server.alive; i++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/config`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.headers.get("content-type")?.includes("application/json")) {
            this.opencode = server;
            return server;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      server.kill();
      throw new Error(`OpenCode did not start. ${stderr.trim()}`.trim());
    })().finally(() => {
      this.opencodeStarting = null;
    });
    return this.opencodeStarting;
  }
  private async opencodeRequest(
    project: string,
    method: string,
    path: string,
    body?: string,
    limit?: number,
  ) {
    const { port } = await this.ensureOpenCode();
    const workspace = this.workspace(project);
    await mkdir(workspace.dir, { recursive: true });
    this.opencodeEvents(project);
    const query = `directory=${encodeURIComponent(workspace.dir)}${limit ? `&limit=${limit}` : ""}`;
    const response = await fetch(`http://127.0.0.1:${port}${path}?${query}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-opencode-directory": encodeURIComponent(workspace.dir),
      },
      body: method === "GET" ? undefined : (body ?? "{}"),
      signal: AbortSignal.timeout(110_000),
    });
    return {
      status: response.status,
      type: response.headers.get("content-type") ?? "",
      body: await response.text(),
    };
  }
  private async opencodeFetch(project: string, params: Json) {
    const method = String(params.method ?? "GET"),
      path = String(params.path ?? "");
    if (!OPENCODE_CALLS.some(([m, pattern]) => m === method && pattern.test(path)))
      throw new Error("OpenCode request not allowed");
    const result = await this.opencodeRequest(
      project,
      method,
      path,
      typeof params.body === "string" ? params.body : undefined,
      typeof params.limit === "number" ? params.limit : undefined,
    );
    // Provider options and keys never leave the runner.
    if (/^\/(config|agent|provider)$/.test(path) && result.status === 200)
      return { ...result, body: JSON.stringify(openCodeSettings(path, result.body)) };
    return result;
  }
  /** A prompt is a turn: the working copy comes up to date first; the end pushes changes. */
  private async opencodePrompt(project: string, threadId: string, params: Json) {
    const workspace = this.workspace(project);
    if (workspace.thread) throw new Error("Another AI turn is still running in this project");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(threadId)) throw new Error("Invalid OpenCode session");
    workspace.thread = threadId;
    try {
      await this.sync(project, workspace, (params.files ?? []) as AgentFile[]);
      const body = JSON.parse(String(params.body ?? "{}")) as { parts?: Json[] };
      // The desktop's context line speaks of its delegation tools; the runner has none.
      for (const part of body.parts ?? [])
        if (part.type === "text" && typeof part.text === "string")
          part.text = part.text.replace(
            /^(\[Writer conversation ID: opencode:[^\]\n]+\]\n)[^\n]*\n\n/,
            `$1${OPENCODE_CONTEXT}\n\n`,
          );
      const result = await this.opencodeRequest(
        project,
        "POST",
        `/session/${threadId}/prompt_async`,
        JSON.stringify(body),
      );
      if (result.status >= 300) workspace.thread = null;
      return result;
    } catch (error) {
      workspace.thread = null;
      throw error;
    }
  }
  /** The project's event stream, kept open (and reopened) while the runner runs. */
  private opencodeEvents(project: string) {
    if (this.opencodeStreams.has(project)) return;
    const controller = new AbortController();
    this.opencodeStreams.set(project, controller);
    const workspace = this.workspace(project);
    void (async () => {
      while (!controller.signal.aborted && !this.stopped) {
        try {
          const { port } = await this.ensureOpenCode();
          const response = await fetch(
            `http://127.0.0.1:${port}/event?directory=${encodeURIComponent(workspace.dir)}`,
            { headers: { Accept: "text/event-stream" }, signal: controller.signal },
          );
          if (!response.body) throw new Error("no event stream");
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk as Uint8Array, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const data = block
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""))
                .join("\n");
              if (!data) continue;
              try {
                this.fromOpenCode(project, workspace, JSON.parse(data) as Json);
              } catch {}
            }
          }
        } catch {}
        if (!controller.signal.aborted) await new Promise((r) => setTimeout(r, 2000));
      }
    })();
  }
  /** Queued per project like Codex's events: a step's or a turn's changes go first. */
  private fromOpenCode(project: string, workspace: Workspace, event: Json) {
    const props = (event.properties ?? {}) as Json;
    const part = props.part as Json | undefined;
    const info = props.info as Json | undefined;
    const type = String(event.type ?? "");
    const session =
      (typeof props.sessionID === "string" && props.sessionID) ||
      (typeof part?.sessionID === "string" && part.sessionID) ||
      (typeof info?.sessionID === "string" && info.sessionID) ||
      (type.startsWith("session.") && typeof info?.id === "string" && info.id) ||
      null;
    if (!session) return;
    const step =
      type === "message.part.updated" &&
      part?.type === "tool" &&
      (part.state as Json | undefined)?.status === "completed";
    const finished =
      type === "session.idle" ||
      (type === "session.status" && (props.status as Json | undefined)?.type === "idle");
    workspace.queue = workspace.queue
      .then(async () => {
        if ((step || finished) && workspace.thread === session)
          await this.push(project, workspace, session).catch((error) =>
            this.log(
              `Writer AI changes not sent: ${error instanceof Error ? error.message : error}`,
            ),
          );
        if (finished && workspace.thread === session) workspace.thread = null;
        this.send({
          project,
          event: { method: OPENCODE_EVENT, params: { threadId: session, event } },
        });
      })
      .catch(() => {});
  }
  private claudeBinary() {
    return this.options.claude || process.env.WRITER_CLAUDE_BIN || "claude";
  }
  private claudeFiles(project: string, threadId: string) {
    this.workspace(project);
    if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error("Invalid Claude session ID");
    const dir = join(this.sessions, project);
    return { dir, meta: join(dir, `${threadId}.json`), log: join(dir, `${threadId}.jsonl`) };
  }
  /** Once Claude Code has its own record of the session, later turns resume it. */
  private async claudeNative(project: string, threadId: string) {
    try {
      const meta = JSON.parse(await readFile(this.claudeFiles(project, threadId).meta, "utf8"));
      return meta.native === true;
    } catch {
      return false;
    }
  }
  private async claudeAppend(project: string, threadId: string, event: Json, native: boolean) {
    const files = this.claudeFiles(project, threadId);
    await mkdir(files.dir, { recursive: true });
    await appendFile(files.log, `${JSON.stringify(event)}\n`);
    if (native && !(await this.claudeNative(project, threadId)))
      await writeFile(files.meta, JSON.stringify({ native: true }));
  }
  /** The account's models, from a short-lived CLI (kept for ten minutes). */
  private async claudeModels(project: string) {
    if (this.claudeCatalog && Date.now() - this.claudeCatalog.at < 600_000)
      return this.claudeCatalog.value;
    const workspace = this.workspace(project);
    await mkdir(workspace.dir, { recursive: true });
    const { child, kill } = spawnAgent(this.claudeBinary(), CLAUDE_ARGS, workspace.dir);
    try {
      const value = await new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Claude Code start-up timed out")), 40_000);
        const fail = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        };
        child.on("error", fail);
        child.on("exit", () =>
          fail(new Error("Claude Code exited during start-up. Check the CLI setup on the runner.")),
        );
        child.stdin.on("error", () => {});
        child.stderr.resume();
        createInterface({ input: child.stdout }).on("line", (line) => {
          let event: Json;
          try {
            event = JSON.parse(line) as Json;
          } catch {
            return;
          }
          const response = event.response as Json | undefined;
          if (event.type !== "control_response" || response?.request_id !== "writer-init") return;
          clearTimeout(timer);
          if (response.subtype === "error") reject(new Error(String(response.error)));
          else
            resolve({
              models: (response.response as Json | undefined)?.models ?? [],
              available: true,
            });
        });
        child.stdin.write(`${JSON.stringify(CLAUDE_INIT)}\n`);
      });
      this.claudeCatalog = { at: Date.now(), value };
      return value;
    } finally {
      kill();
    }
  }
  private async claudeRead(project: string, threadId: string) {
    const text = await readFile(this.claudeFiles(project, threadId).log, "utf8").catch(() => "");
    const events = text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        // A line cut short by a crash is skipped rather than failing the whole history.
        try {
          return [JSON.parse(line) as Json];
        } catch {
          return [];
        }
      });
    const run = this.claudeRuns.get(threadId);
    return { events, busy: !!run?.busy, pending: run ? [...run.pending.values()] : [] };
  }
  /** Claude events reach the server in order; a finished tool's file changes go first. */
  private claudeEmit(
    project: string,
    workspace: Workspace,
    threadId: string,
    event: Json,
    push = false,
  ) {
    workspace.queue = workspace.queue
      .then(async () => {
        if (push)
          await this.push(project, workspace, threadId).catch((error) =>
            this.log(
              `Writer AI changes not sent: ${error instanceof Error ? error.message : error}`,
            ),
          );
        this.send({ project, event: { method: CLAUDE_EVENT, params: { threadId, event } } });
      })
      .catch(() => {});
  }
  private async claudeTurn(project: string, threadId: string, params: Json) {
    const workspace = this.workspace(project);
    this.claudeFiles(project, threadId);
    if (workspace.thread) throw new Error("Another AI turn is still running in this project");
    if (this.claudeRuns.get(threadId)?.busy) throw new Error("This conversation is still running.");
    const mode = params.permissionMode as ClaudePermission;
    if (!this.claudePermissions.includes(mode))
      throw new Error("This runner does not support that permission mode");
    const effort = typeof params.effort === "string" && params.effort ? params.effort : null;
    if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort))
      throw new Error("Invalid reasoning effort");
    const model =
      typeof params.model === "string" && params.model && params.model !== "default"
        ? params.model
        : null;
    const images = Array.isArray(params.images)
      ? params.images.filter((i): i is string => typeof i === "string")
      : [];
    const input = claudeInput(typeof params.text === "string" ? params.text : "", images);
    workspace.thread = threadId;
    try {
      await this.sync(project, workspace, (params.files ?? []) as AgentFile[]);
      const native = await this.claudeNative(project, threadId);
      const { child, kill } = spawnAgent(
        this.claudeBinary(),
        [
          ...CLAUDE_ARGS,
          native ? `--resume=${threadId}` : `--session-id=${threadId}`,
          ...claudePermissionArgs(mode),
          "--append-system-prompt",
          CLAUDE_PROMPT,
          ...(model ? [`--model=${model}`] : []),
          ...(effort ? ["--effort", effort] : []),
        ],
        workspace.dir,
      );
      child.stdin.on("error", () => {});
      const run: ClaudeRun = {
        pending: new Map(),
        busy: true,
        delivery: { accepting: true, initialized: false, outstanding: 1 },
        send: (message) => {
          if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        kill,
      };
      this.claudeRuns.set(threadId, run);
      await this.claudeAppend(project, threadId, input, false);
      this.claudeEmit(project, workspace, threadId, input);
      this.claudeEmit(project, workspace, threadId, { type: "writer_started" });
      this.claudeWatch(project, workspace, threadId, run, child, input);
      run.send(CLAUDE_INIT);
      return { ok: true };
    } catch (error) {
      workspace.thread = null;
      throw error;
    }
  }
  /** One turn's stream, as the desktop's bridge reads it: steering, approvals, the end. */
  private claudeWatch(
    project: string,
    workspace: Workspace,
    threadId: string,
    run: ClaudeRun,
    child: ChildProcessWithoutNullStreams,
    input: Json,
  ) {
    let initialized = false,
      resultSeen = false,
      failure: string | null = null,
      stderr = "",
      finished = false;
    const startup = setTimeout(() => {
      if (initialized) return;
      failure = "Claude Code start-up timed out.";
      run.kill();
    }, 60_000);
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: Json;
      try {
        event = JSON.parse(line) as Json;
      } catch {
        return;
      }
      const response = event.response as Json | undefined;
      if (event.type === "control_response" && response?.request_id === "writer-init") {
        if (response.subtype === "error") {
          failure = String(response.error);
          run.kill();
          return;
        }
        initialized = true;
        clearTimeout(startup);
        run.send(input);
        run.delivery.initialized = true;
        return;
      }
      if (event.type === "control_request" && typeof event.request_id === "string") {
        if ((event.request as Json | undefined)?.subtype !== "can_use_tool") {
          run.send({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: event.request_id,
              error: "Unsupported control request",
            },
          });
          return;
        }
        run.pending.set(event.request_id, event);
      }
      if (event.type === "control_cancel_request" && typeof event.request_id === "string")
        run.pending.delete(event.request_id);
      if (event.type === "result") {
        // A steered turn ends with the interrupted result; the replacement message goes on.
        if (run.delivery.accepting && run.delivery.outstanding > 1) {
          run.delivery.outstanding--;
          run.pending.clear();
          this.claudeEmit(project, workspace, threadId, { type: "writer_steering" });
          return;
        }
        run.delivery.accepting = false;
      }
      if (
        ["assistant", "user", "result"].includes(String(event.type)) ||
        (event.type === "system" && event.subtype === "init")
      )
        void this.claudeAppend(
          project,
          threadId,
          event,
          event.type === "assistant" || event.type === "system",
        ).catch((error) => {
          failure = `Could not save the history: ${error}`;
        });
      const content = (event.message as { content?: unknown } | undefined)?.content;
      const toolDone =
        event.type === "user" &&
        Array.isArray(content) &&
        content.some((block) => (block as Json | null)?.type === "tool_result");
      this.claudeEmit(project, workspace, threadId, event, toolDone);
      if (event.type === "result") {
        resultSeen = true;
        child.stdin.end();
        setTimeout(() => run.kill(), 5000).unref();
      }
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(startup);
      run.pending.clear();
      run.busy = false;
      if (!resultSeen && !failure)
        failure =
          stderr.trim() ||
          "Claude Code exited early. Check the sign-in and model setup on the runner.";
      if (failure) {
        const event = { type: "writer_error", error: failure };
        void this.claudeAppend(project, threadId, event, false).catch(() => {});
        this.claudeEmit(project, workspace, threadId, event);
      }
      if (this.claudeRuns.get(threadId) === run) this.claudeRuns.delete(threadId);
      // The last changes reach the server before the turn is reported finished.
      workspace.queue = workspace.queue
        .then(async () => {
          await this.push(project, workspace, threadId).catch((error) =>
            this.log(
              `Writer AI changes not sent: ${error instanceof Error ? error.message : error}`,
            ),
          );
          if (workspace.thread === threadId) workspace.thread = null;
          this.send({
            project,
            event: { method: CLAUDE_EVENT, params: { threadId, event: { type: "writer_done" } } },
          });
        })
        .catch(() => {});
    };
    child.on("close", finish);
    child.on("error", (error) => {
      failure ??= `Could not start Claude Code: ${error.message}`;
      finish();
    });
  }
  private async claudeSteer(project: string, threadId: string, params: Json) {
    const run = this.claudeRuns.get(threadId);
    if (!run) throw new Error("The current task has finished; send normally.");
    if (!run.busy || !run.delivery.accepting || !run.delivery.initialized)
      throw new Error(
        "The current task has finished or is not ready yet; send normally in a moment.",
      );
    if (run.delivery.outstanding > 1)
      throw new Error(
        "The previous guidance is still being delivered; send later or add it to the queue.",
      );
    const images = Array.isArray(params.images)
      ? params.images.filter((i): i is string => typeof i === "string")
      : [];
    const message = claudeInput(typeof params.text === "string" ? params.text : "", images);
    // Interrupt and the new message share the ordered stdin of the same native session.
    run.delivery.outstanding++;
    run.send({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    run.send(message);
    await this.claudeAppend(project, threadId, message, false);
    this.claudeEmit(project, this.workspace(project), threadId, message);
    return { ok: true };
  }
  private claudeRespond(threadId: string, params: Json) {
    const run = this.claudeRuns.get(threadId);
    if (!run) throw new Error("The Claude conversation has ended");
    const requestId = String(params.requestId ?? "");
    const request = run.pending.get(requestId);
    if (!request) throw new Error("This permission request has ended");
    const body = (request.request ?? {}) as Json;
    const allow = params.allow === true;
    let input = { ...((body.input as Json | undefined) ?? {}) };
    if (body.tool_name === "AskUserQuestion" && allow)
      input = { ...input, answers: params.answers ?? {} };
    run.send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: allow
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "The user denied this action." },
      },
    });
    run.pending.delete(requestId);
    return { ok: true };
  }
  /** Queued per project, so a turn's changes reach the server before its end is reported. */
  private fromCodex(message: Json) {
    const params = (message.params ?? {}) as Json;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const project = threadId ? this.threadProject.get(threadId) : undefined;
    if (!threadId || !project) return;
    const workspace = this.workspace(project);
    const item = params.item as { type?: string } | undefined;
    const step =
      message.method === "item/completed" &&
      (item?.type === "fileChange" || item?.type === "commandExecution");
    const finished = message.method === "turn/completed";
    workspace.queue = workspace.queue
      .then(async () => {
        if ((step || finished) && workspace.thread === threadId)
          await this.push(project, workspace, threadId).catch((error) =>
            this.log(
              `Writer AI changes not sent: ${error instanceof Error ? error.message : error}`,
            ),
          );
        if (finished && workspace.thread === threadId) workspace.thread = null;
        this.send({ event: message, project });
      })
      .catch(() => {});
  }
}

export function startAgentHost(options: AgentHostOptions) {
  return new AgentHost(options).start();
}
