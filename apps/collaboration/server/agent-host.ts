/**
 * The shared runner's side of live AI conversations (see agents.ts for the server's side).
 * One Codex app-server serves every project; each project has its own working folder, which
 * is brought up to date with the server before every turn. What the agent changes goes back
 * to the server after each step and before the turn is reported finished; the server merges
 * it into the shared text. The working folder is a disposable copy: the server is the record.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  codex?: string;
  permissions?: AgentPermission[];
  log?: (message: string) => void;
};

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
    // The agent runs collaborators' prompts: it gets none of Writer's tokens or passwords.
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/^WRITER_.*(TOKEN|PASSWORD|DATABASE_URL)/.test(key)) delete env[key];
    this.child = spawn(binary, ["-c", 'web_search="live"', "app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
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
  constructor(private options: AgentHostOptions) {
    this.root =
      options.root ||
      process.env.WRITER_AGENT_WORKSPACES ||
      join(homedir(), ".writer-runner", "projects");
    this.permissions = options.permissions ?? defaultPermissions();
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
      this.log(`Writer AI conversations connected (${this.permissions.join(",")})`);
      this.send({ status: { harnesses: ["codex"], permissions: this.permissions } });
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
