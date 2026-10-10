import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AGENT_PERMISSIONS, CHANGES_EVENT, THREADS_EVENT } from "../shared/agents";
import { resolveChanges } from "../shared/tracked";
import { AgentHost } from "./agent-host";
import { fixture } from "./test-fixture";

const TOKEN = "a".repeat(64);
// biome-ignore lint/suspicious/noExplicitAny: test messages are free-form JSON.
type Message = any;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A socket speaking the relay's JSON: requests by id, everything else kept for `until`. */
function client(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const messages: Message[] = [];
  const waiters: Array<{ test: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    for (const waiter of [...waiters])
      if (waiter.test(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
  });
  const until = (test: (m: Message) => boolean, ms = 8000) => {
    const found = messages.find(test);
    if (found) return Promise.resolve(found);
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`timed out; got ${JSON.stringify(messages.slice(-6)).slice(0, 3000)}`)),
        ms,
      );
      waiters.push({
        test,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };
  let next = 0;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = `r${++next}`;
    ws.send(JSON.stringify({ id, method, params }));
    const reply = await until((m) => m.id === id && !m.method);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  cleanups.push(() => ws.terminate());
  return { ws, messages, until, request, opened };
}

async function setup(capabilities = ["codex"]) {
  const f = await fixture({
    sharedRunner: { token: TOKEN, name: "Lab runner", capabilities },
  });
  const origin = f.app.origin;
  const browser = async (cookie: string) => {
    const b = client(`${origin.replace("http:", "ws:")}/api/projects/${f.project}/agents`, {
      Cookie: cookie,
      Origin: origin,
    });
    await b.opened;
    return b;
  };
  const file = async (path: string, content: string) =>
    (await f.call(`/projects/${f.project}/files`, { path, content }, f.owner)).data.id as string;
  const text = async (id: string) =>
    (await f.call(`/projects/${f.project}/files/${id}`, undefined, f.owner)).data.content;
  return { ...f, origin, browser, file, text };
}

/** The shared runner with the fake Codex, working in a temporary folder. */
async function codexRunner(server: string) {
  const dir = await mkdtemp(join(tmpdir(), "writer-agents-"));
  const codex = join(dir, "codex.sh");
  await writeFile(
    codex,
    `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-codex.mjs")}" "$@"\n`,
  );
  await chmod(codex, 0o755);
  const host = new AgentHost({
    server,
    token: TOKEN,
    root: join(dir, "work"),
    codex,
    permissions: [...AGENT_PERMISSIONS],
    log: () => {},
  }).start();
  cleanups.push(async () => {
    host.stop();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, host };
}

describe("live AI conversations on the shared runner", () => {
  it("runs a Codex turn whose edits land in the shared text, with a version before it", async () => {
    const f = await setup();
    const { dir, host } = await codexRunner(f.origin);
    const chapter = await f.file("chapter.tex", "Hello world\n");
    const owner = await f.browser(f.owner);
    await owner.until((m) => m.status?.online && m.status.harnesses.includes("codex"));
    await owner.request("codex.initialize");
    expect((await owner.request("codex.models")).data[0].model).toBe("fake-model");
    const { thread } = await owner.request("codex.startThread", { permissionMode: "fullAccess" });
    expect(await owner.request("codex.threads")).toMatchObject({
      data: [{ id: thread.id, mine: true, shared: true, ownerName: "owner" }],
    });
    // The agents' Writer tools reach the server through the runner, with the runner's key.
    const bridge = await host.bridge();
    const post = async (key: string, body: unknown) => {
      const r = await fetch(bridge.url, {
        method: "POST",
        headers: { "X-Writer-Bridge": key },
        body: JSON.stringify(body),
      });
      return [r.status, await r.json()];
    };
    expect(await post("wrong", { method: "list" })).toEqual([403, { error: "Forbidden" }]);
    expect(await post(bridge.key, { method: "list", params: { threadId: thread.id } })).toEqual([
      200,
      { error: "Only the conversation whose turn is running can use the Writer tools" },
    ]);

    const { turn } = await owner.request("codex.startTurn", {
      threadId: thread.id,
      text: "replace chapter.tex world=>team",
      permissionMode: "fullAccess",
    });
    expect(turn.id).toBeTruthy();
    const changed = await owner.until((m) => m.event?.method === CHANGES_EVENT);
    expect(changed.event.params.results).toEqual([{ path: "chapter.tex", status: "applied" }]);
    await owner.until((m) => m.event?.method === "turn/completed");
    expect(await f.text(chapter)).toBe("Hello team\n");
    expect(owner.messages.filter((m) => "busy" in m).at(-1).busy).toBeNull();
    const versions = (await f.call(`/projects/${f.project}/snapshots`, undefined, f.owner)).data;
    expect(versions.map((v: { label: string }) => v.label)).toContain("AI 对话修改前");
    const read = await owner.request("codex.read", { threadId: thread.id });
    expect(read.thread.turns).toHaveLength(1);
    // Writer's context line rides along with the member's words, as on the desktop.
    expect(read.thread.turns[0].items[0].content[0].text).toMatch(
      /^\[Writer conversation ID: codex:[^\n]+\]\n[^\n]+\n\nreplace chapter\.tex/,
    );

    // Approval mode: the request reaches the browser, and its answer goes back to Codex.
    await owner.request("codex.startTurn", {
      threadId: thread.id,
      text: "ask chapter.tex team=>lab",
      permissionMode: "askForApproval",
    });
    const ask = await owner.until((m) => m.event?.method === "item/fileChange/requestApproval");
    const [pending] = await owner.request("codex.pending");
    expect(pending.id).toBe(ask.event.id);
    // One AI turn per project: another conversation waits.
    const other = await owner.request("codex.startThread", { permissionMode: "fullAccess" });
    await expect(
      owner.request("codex.startTurn", {
        threadId: other.thread.id,
        text: "create notes.md x",
        permissionMode: "fullAccess",
      }),
    ).rejects.toThrow(/正在修改此项目/);
    await owner.request("codex.respond", {
      threadId: thread.id,
      requestId: ask.event.id,
      response: { decision: "accept" },
    });
    await owner.until(
      (m) => m.event?.method === "turn/completed" && m.event.params.turn.id !== turn.id,
    );
    expect(await f.text(chapter)).toBe("Hello lab\n");

    // Files the agent creates and deletes follow; the working copy is the runner's own.
    await owner.request("codex.startTurn", {
      threadId: other.thread.id,
      text: "create figures/notes.md first notes",
      permissionMode: "fullAccess",
    });
    await owner.until(
      (m) =>
        m.event?.method === CHANGES_EVENT &&
        m.event.params.results.some((r: { path: string }) => r.path === "figures/notes.md"),
    );
    const files = (await f.call(`/projects/${f.project}/files`, undefined, f.owner)).data;
    expect(files.map((x: { path: string }) => x.path)).toContain("figures/notes.md");
    expect(await readFile(join(dir, "work", f.project, "chapter.tex"), "utf8")).toBe("Hello lab\n");
  });

  it("records a turn's edits as tracked changes while track changes is on", async () => {
    const f = await setup();
    await codexRunner(f.origin);
    const chapter = await f.file("chapter.tex", "Hello world\n");
    await f.call(`/projects/${f.project}/tracking`, { everyone: true }, f.owner);
    const owner = await f.browser(f.owner);
    await owner.until((m) => m.status?.online && m.status.harnesses.includes("codex"));
    await owner.request("codex.initialize");
    const { thread } = await owner.request("codex.startThread", { permissionMode: "fullAccess" });
    await owner.request("codex.startTurn", {
      threadId: thread.id,
      text: "replace chapter.tex world=>team",
      permissionMode: "fullAccess",
    });
    await owner.until((m) => m.event?.method === CHANGES_EVENT);
    expect(await f.text(chapter)).toBe("Hello team\n");
    const { doc } = await f.peer(f.owner, chapter);
    const text = doc.getText("content").toString();
    expect(
      resolveChanges(doc).changes.map((c) => [c.kind, c.name, c.text ?? text.slice(c.from, c.to)]),
    ).toEqual([
      ["delete", "Codex · owner", "world"],
      ["insert", "Codex · owner", "team"],
    ]);
  });

  it("shares conversations with the project unless hidden, and admits only owners and editors", async () => {
    const f = await setup();
    const runner = client(`${f.origin.replace("http:", "ws:")}/api/runner/agents`, {
      Authorization: `Bearer ${TOKEN}`,
    });
    await runner.opened;
    runner.ws.send(
      JSON.stringify({
        status: { harnesses: ["codex", "other"], permissions: { codex: ["fullAccess"] } },
      }),
    );
    let threads = 0;
    runner.ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (!m.method) return;
      const result =
        m.method === "codex.startThread"
          ? { thread: { id: `thread-${++threads}` } }
          : m.method === "codex.read"
            ? { thread: { id: m.params.threadId, turns: [] } }
            : {};
      runner.ws.send(JSON.stringify({ id: m.id, result }));
    });
    const editorCookie = await f.invite("editor", "editor1");
    const commenterCookie = await f.invite("commenter", "commenter1");
    await expect(f.browser(commenterCookie)).rejects.toThrow(/403/);
    const owner = await f.browser(f.owner);
    const editor = await f.browser(editorCookie);
    await owner.until((m) => m.status?.online && m.status.permissions.codex?.length === 1);
    expect(owner.messages.find((m) => m.status?.online).status).toMatchObject({
      name: "Lab runner",
      harnesses: ["codex"],
      permissions: { codex: ["fullAccess"] },
    });
    await expect(
      owner.request("codex.startThread", { permissionMode: "askForApproval" }),
    ).rejects.toThrow(/权限模式/);
    const { thread } = await owner.request("codex.startThread", { permissionMode: "fullAccess" });

    // New conversations are the project's; whoever started one may hide it again.
    expect((await editor.request("codex.threads")).data).toMatchObject([
      { id: thread.id, mine: false, shared: true },
    ]);
    await owner.request("thread.share", { threadId: thread.id, shared: false });
    expect((await editor.request("codex.threads")).data).toEqual([]);
    await expect(editor.request("codex.read", { threadId: thread.id })).rejects.toThrow(
      /不存在或未共享/,
    );
    editor.messages.length = 0;
    await owner.request("thread.share", { threadId: thread.id, shared: true });
    await editor.until((m) => m.event?.method === THREADS_EVENT);
    expect((await editor.request("codex.threads")).data).toMatchObject([
      { id: thread.id, mine: false, shared: true, ownerName: "owner" },
    ]);
    expect((await editor.request("codex.read", { threadId: thread.id })).thread.id).toBe(thread.id);
    await expect(
      editor.request("codex.rename", { threadId: thread.id, name: "mine now" }),
    ).rejects.toThrow(/发起人/);
    await expect(
      editor.request("thread.share", { threadId: thread.id, shared: false }),
    ).rejects.toThrow(/发起人/);
    await owner.request("codex.rename", { threadId: thread.id, name: "Literature check" });
    expect((await editor.request("codex.threads")).data[0].name).toBe("Literature check");

    // Events of a shared conversation reach every member who can see it.
    runner.ws.send(
      JSON.stringify({
        project: f.project,
        event: { method: "item/completed", params: { threadId: thread.id, item: { id: "i" } } },
      }),
    );
    await editor.until((m) => m.event?.method === "item/completed");
    // A wrong runner token is refused.
    const intruder = client(`${f.origin.replace("http:", "ws:")}/api/runner/agents`, {
      Authorization: `Bearer ${"b".repeat(64)}`,
    });
    await expect(intruder.opened).rejects.toThrow(/403/);
  });

  it("shows a conversation in another project read-only, for members of both", async () => {
    const f = await setup();
    const runner = client(`${f.origin.replace("http:", "ws:")}/api/runner/agents`, {
      Authorization: `Bearer ${TOKEN}`,
    });
    await runner.opened;
    runner.ws.send(
      JSON.stringify({ status: { harnesses: ["codex"], permissions: { codex: ["fullAccess"] } } }),
    );
    const asked: Message[] = [];
    runner.ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (!m.method) return;
      asked.push(m);
      const result =
        m.method === "codex.startThread"
          ? { thread: { id: "thread-linked" } }
          : m.method === "codex.read"
            ? { thread: { id: m.params.threadId, turns: [] } }
            : {};
      runner.ws.send(JSON.stringify({ id: m.id, result }));
    });
    const second = (await f.call("/projects", { name: "second-paper" }, f.owner)).data.id as string;
    const owner = await f.browser(f.owner);
    await owner.until((m) => m.status?.online);
    const { thread } = await owner.request("codex.startThread", { permissionMode: "fullAccess" });
    const there = client(`${f.origin.replace("http:", "ws:")}/api/projects/${second}/agents`, {
      Cookie: f.owner,
      Origin: f.origin,
    });
    await there.opened;
    expect((await there.request("codex.threads")).data).toEqual([]);

    // An editor of this project alone cannot place it in a project they do not edit.
    const editor = await f.browser(await f.invite("editor", "editor-only"));
    await expect(
      editor.request("thread.link", { threadId: thread.id, project: second }),
    ).rejects.toThrow(/无权访问/);
    await expect(
      owner.request("thread.link", { threadId: thread.id, project: f.project }),
    ).rejects.toThrow(/无效字段/);
    await owner.request("thread.link", { threadId: thread.id, project: second });
    await there.until((m) => m.event?.method === THREADS_EVENT);
    expect(await owner.request("thread.links", { threadId: thread.id })).toEqual([
      { id: second, name: "second-paper" },
    ]);
    expect((await there.request("codex.threads")).data).toMatchObject([
      { id: thread.id, mine: false, linkedFrom: { id: f.project, name: "test-paper" } },
    ]);
    expect((await owner.request("codex.threads")).data[0].linkedFrom).toBeNull();
    // Read from the project it belongs to; continued only there.
    await there.request("codex.read", { threadId: thread.id });
    expect(asked.findLast((m) => m.method === "codex.read").params.project).toBe(f.project);
    await expect(
      there.request("codex.startTurn", {
        threadId: thread.id,
        text: "hello",
        permissionMode: "fullAccess",
      }),
    ).rejects.toThrow(/只能查看/);
    await expect(there.request("codex.rename", { threadId: thread.id, name: "x" })).rejects.toThrow(
      /只能查看/,
    );

    // Hidden again, it leaves the other project too, and cannot be linked while hidden.
    await owner.request("thread.share", { threadId: thread.id, shared: false });
    expect((await there.request("codex.threads")).data).toEqual([]);
    await expect(there.request("codex.read", { threadId: thread.id })).rejects.toThrow(
      /不存在或未共享/,
    );
    await owner.request("thread.share", { threadId: thread.id, shared: true });
    expect((await there.request("codex.threads")).data).toHaveLength(1);
    await there.request("thread.unlink", { threadId: thread.id, project: second });
    expect((await there.request("codex.threads")).data).toEqual([]);
    await owner.request("thread.share", { threadId: thread.id, shared: false });
    await expect(
      owner.request("thread.link", { threadId: thread.id, project: second }),
    ).rejects.toThrow(/先把对话共享/);
  });

  it("lets the running conversation read another and hand it a task whose answer comes back", async () => {
    const f = await setup();
    const runner = client(`${f.origin.replace("http:", "ws:")}/api/runner/agents`, {
      Authorization: `Bearer ${TOKEN}`,
    });
    await runner.opened;
    runner.ws.send(
      JSON.stringify({ status: { harnesses: ["codex"], permissions: { codex: ["fullAccess"] } } }),
    );
    // A Codex that remembers what each conversation was told and answers "done: <message>".
    const said = new Map<string, string[]>();
    const turns: Array<{ threadId: string; text: string; permissionMode: string }> = [];
    let threads = 0;
    runner.ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (!m.method) return;
      let result: unknown = {};
      if (m.method === "codex.startThread") result = { thread: { id: `thread-${++threads}` } };
      if (m.method === "codex.startTurn") {
        turns.push(m.params);
        said.set(m.params.threadId, [...(said.get(m.params.threadId) ?? []), m.params.text]);
      }
      if (m.method === "codex.read")
        result = {
          thread: {
            id: m.params.threadId,
            turns: (said.get(m.params.threadId) ?? []).map((text, i) => ({
              id: `t${i}`,
              items: [
                {
                  type: "userMessage",
                  content: [
                    {
                      type: "text",
                      text: `[Writer conversation ID: codex:${m.params.threadId}]\ncontext\n\n${text}`,
                    },
                  ],
                },
                ...(i === 0 && m.params.threadId === "thread-2"
                  ? []
                  : [{ type: "agentMessage", text: `done: ${text.split("\n").at(-1)}` }]),
              ],
            })),
          },
        };
      runner.ws.send(JSON.stringify({ id: m.id, result }));
    });
    const turnCount = async (count: number) => {
      for (let i = 0; i < 200 && turns.length < count; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(turns).toHaveLength(count);
    };
    const event = (method: string, threadId: string) =>
      runner.ws.send(
        JSON.stringify({ project: f.project, event: { method, params: { threadId, turn: {} } } }),
      );
    const owner = await f.browser(f.owner);
    await owner.until((m) => m.status?.online);
    const writer = (await owner.request("codex.startThread", { permissionMode: "fullAccess" }))
      .thread.id;
    const checker = (await owner.request("codex.startThread", { permissionMode: "fullAccess" }))
      .thread.id;
    await owner.request("codex.rename", { threadId: checker, name: "Reference checker" });
    // An earlier exchange of the checker that went unanswered.
    said.set(checker, ["look at chapter 1"]);

    // Only the conversation whose turn is running speaks through the tools.
    await expect(runner.request("bridge.list", { threadId: writer })).rejects.toThrow(
      /Only the conversation whose turn is running/,
    );
    await owner.request("codex.startTurn", {
      threadId: writer,
      text: "write the intro",
      permissionMode: "fullAccess",
    });
    event("turn/started", writer);
    const list = await runner.request("bridge.list", { threadId: writer });
    expect(list.map((c: { id: string; you: boolean }) => [c.id, c.you])).toEqual([
      [writer, true],
      [checker, false],
    ]);
    expect(list[1]).toMatchObject({ harness: "codex", title: "Reference checker", owner: "owner" });
    const read = await runner.request("bridge.read", { threadId: writer, target: checker });
    expect(read.text).toBe("USER: look at chapter 1");
    await expect(
      runner.request("bridge.delegate", { threadId: writer, target: writer, message: "x" }),
    ).rejects.toThrow(/itself/);
    const { task } = await runner.request("bridge.delegate", {
      threadId: writer,
      target: checker,
      message: "check the references",
    });
    expect(await runner.request("bridge.task", { threadId: writer, task })).toMatchObject({
      status: "queued",
    });

    // The writer's turn ends: the checker gets the task, in the name of whoever started it.
    event("turn/completed", writer);
    await turnCount(2);
    expect(turns.at(-1)).toMatchObject({ threadId: checker, permissionMode: "fullAccess" });
    expect(turns.at(-1)?.text).toContain(
      `[Writer delegated task ${task} from conversation ${writer}]`,
    );
    await expect(
      runner.request("bridge.delegate", { threadId: checker, target: writer, message: "back" }),
    ).rejects.toThrow(/cannot be handed on again/);
    // Its answer goes back to the writer as a new message once the checker is done.
    event("turn/completed", checker);
    await turnCount(3);
    expect(turns.at(-1)?.threadId).toBe(writer);
    expect(turns.at(-1)?.text).toContain("done: check the references");
    expect(turns.at(-1)?.text).not.toContain("look at chapter 1");
    expect(await runner.request("bridge.task", { threadId: writer, task })).toMatchObject({
      status: "done",
      result: "done: check the references",
    });
  });

  it("merges the agent's changes with collaborators' and keeps overlaps as suggestions", async () => {
    const f = await setup();
    const runner = client(`${f.origin.replace("http:", "ws:")}/api/runner/agents`, {
      Authorization: `Bearer ${TOKEN}`,
    });
    await runner.opened;
    runner.ws.send(
      JSON.stringify({ status: { harnesses: ["codex"], permissions: { codex: ["fullAccess"] } } }),
    );
    runner.ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.method === "codex.startThread")
        runner.ws.send(JSON.stringify({ id: m.id, result: { thread: { id: "merge-thread" } } }));
    });
    const owner = await f.browser(f.owner);
    await owner.until((m) => m.status?.online);
    await owner.request("codex.startThread", { permissionMode: "fullAccess" });
    const id = await f.file("paper.tex", "alpha\nbeta\ngamma\n");
    const old = await f.file("old.tex", "keep me\n");
    const push = (files: unknown[]) =>
      runner.request("changes", { project: f.project, threadId: "merge-thread", files });

    // A collaborator edits another line meanwhile: both edits survive.
    await f.call(
      `/projects/${f.project}/files/${id}`,
      { expected: "alpha\nbeta\ngamma\n", content: "ALPHA\nbeta\ngamma\n" },
      f.owner,
      "PUT",
    );
    const first = await push([
      { path: "paper.tex", base: "alpha\nbeta\ngamma\n", content: "alpha\nBETA\ngamma\n" },
      { path: "fig.png", base: null, base64: Buffer.from("png").toString("base64") },
    ]);
    expect(first.results).toEqual([
      { path: "paper.tex", status: "applied" },
      { path: "fig.png", status: "applied", revision: 1 },
    ]);
    expect(await f.text(id)).toBe("ALPHA\nBETA\ngamma\n");

    // The same line changed by both: the agent's version waits for review.
    await f.call(
      `/projects/${f.project}/files/${id}`,
      { expected: "ALPHA\nBETA\ngamma\n", content: "ALPHA\nBETA\nGamma?\n" },
      f.owner,
      "PUT",
    );
    await f.call(
      `/projects/${f.project}/files/${old}`,
      { expected: "keep me\n", content: "keep me, edited\n" },
      f.owner,
      "PUT",
    );
    const second = await push([
      { path: "paper.tex", base: "ALPHA\nBETA\ngamma\n", content: "ALPHA\nBETA\nGAMMA!\n" },
      { path: "old.tex", base: "keep me\n", deleted: true },
      { path: "fig.png", base: null, revision: 7, base64: Buffer.from("png2").toString("base64") },
    ]);
    expect(second.results.map((r: { status: string }) => r.status)).toEqual([
      "proposal",
      "skipped",
      "skipped",
    ]);
    expect(await f.text(id)).toBe("ALPHA\nBETA\nGamma?\n");
    expect(await f.text(old)).toBe("keep me, edited\n");
    const proposals = (await f.call(`/projects/${f.project}/proposals`, undefined, f.owner)).data;
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposed).toBe("ALPHA\nBETA\nGAMMA!\n");
    const notice = await owner.until(
      (m) => m.event?.method === CHANGES_EVENT && m.event.params.results[0].status === "proposal",
    );
    expect(notice.event.params.results[1].reason).toMatch(/未删除/);
  });
});

describe.skipIf(process.platform === "win32")("Claude Code on the shared runner", () => {
  it("runs turns with approvals, resumes the session and merges the edits", async () => {
    const f = await setup(["codex", "claude"]);
    const dir = await mkdtemp(join(tmpdir(), "writer-claude-"));
    const claude = join(dir, "claude.sh");
    await writeFile(
      claude,
      `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-claude.mjs")}" "$@"\n`,
    );
    await chmod(claude, 0o755);
    const host = new AgentHost({
      server: f.origin,
      token: TOKEN,
      root: join(dir, "work"),
      harnesses: ["claude"],
      claude,
      log: () => {},
    }).start();
    cleanups.push(async () => {
      host.stop();
      await rm(dir, { recursive: true, force: true });
    });
    const chapter = await f.file("chapter.tex", "Hello world\n");
    const owner = await f.browser(f.owner);
    await owner.until((m) => m.status?.online && m.status.harnesses.includes("claude"));
    expect(owner.messages.find((m) => m.status?.online).status.permissions.claude).toEqual([
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
    ]);
    expect((await owner.request("claude.initialize")).models[0].value).toBe("default");
    const session = await owner.request("claude.createSession");
    expect(session).toMatchObject({ directory: f.project, mine: true, shared: true });

    const options = { model: "default", effort: "high", permissionMode: "acceptEdits" };
    await owner.request("claude.startTurn", {
      threadId: session.id,
      text: "replace chapter.tex world=>team",
      images: [],
      options,
    });
    const done = (count: number) =>
      owner.until(
        (m) =>
          owner.messages.filter(
            (x) =>
              x.event?.method === "claude/event" && x.event.params.event.type === "writer_done",
          ).length >= count && m.event?.params?.event?.type === "writer_done",
      );
    await done(1);
    expect(await f.text(chapter)).toBe("Hello team\n");
    expect(owner.messages.some((m) => m.event?.method === CHANGES_EVENT)).toBe(true);
    expect(owner.messages.filter((m) => "busy" in m).at(-1).busy).toBeNull();
    const [listed] = await owner.request("claude.sessions");
    expect(listed).toMatchObject({ id: session.id, name: "replace chapter.tex world=>team" });

    // The default mode asks first; the answer goes back to the CLI, and the session resumes.
    await owner.request("claude.startTurn", {
      threadId: session.id,
      text: "replace chapter.tex team=>lab",
      images: [],
      options: { ...options, permissionMode: "default" },
    });
    const ask = await owner.until(
      (m) =>
        m.event?.params?.event?.type === "control_request" &&
        m.event.params.event.request_id === "p1",
    );
    expect(ask.event.params.threadId).toBe(session.id);
    const pending = await owner.request("claude.read", { threadId: session.id });
    expect(pending.busy).toBe(true);
    expect(pending.pending[0].request_id).toBe("p1");
    await owner.request("claude.respond", { threadId: session.id, requestId: "p1", allow: true });
    await done(2);
    expect(await f.text(chapter)).toBe("Hello lab\n");
    const saved = await owner.request("claude.read", { threadId: session.id });
    expect(saved.busy).toBe(false);
    expect(saved.session.name).toBe("replace chapter.tex world=>team");
    expect(saved.events.filter((e: { type: string }) => e.type === "result").at(-1).result).toBe(
      "changed (resumed)",
    );
    const versions = (await f.call(`/projects/${f.project}/snapshots`, undefined, f.owner)).data;
    expect(versions.filter((v: { label: string }) => v.label === "AI 对话修改前")).toHaveLength(2);
  });
});

describe.skipIf(process.platform === "win32")("OpenCode on the shared runner", () => {
  it("relays its API per session, keeps keys on the runner and merges a prompt's edits", async () => {
    const f = await setup(["codex", "opencode"]);
    const dir = await mkdtemp(join(tmpdir(), "writer-opencode-"));
    const opencode = join(dir, "opencode.sh");
    await writeFile(
      opencode,
      `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-opencode.mjs")}" "$@"\n`,
    );
    await chmod(opencode, 0o755);
    const host = new AgentHost({
      server: f.origin,
      token: TOKEN,
      root: join(dir, "work"),
      harnesses: ["opencode"],
      opencode,
      log: () => {},
    }).start();
    cleanups.push(async () => {
      host.stop();
      await rm(dir, { recursive: true, force: true });
    });
    const chapter = await f.file("chapter.tex", "Hello world\n");
    const owner = await f.browser(f.owner);
    await owner.until((m) => m.status?.online && m.status.harnesses.includes("opencode"));
    const call = (method: string, path: string, body?: unknown, member = owner) =>
      member.request("opencode.fetch", {
        method,
        path,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const config = await call("GET", "/config");
    expect(JSON.parse(config.body)).toEqual({ model: "fake/model" });
    expect((await call("GET", "/provider")).body).not.toContain("sk-secret");
    await expect(call("GET", "/file/content")).rejects.toThrow(/接口不存在/);

    const session = JSON.parse((await call("POST", "/session", {})).body);
    const prompt = await call("POST", `/session/${session.id}/prompt_async`, {
      parts: [
        {
          type: "text",
          text: `[Writer conversation ID: opencode:${session.id}]\nWriter MCP supports peer delegation.\n\nreplace chapter.tex world=>team`,
        },
      ],
    });
    expect(prompt.status).toBe(204);
    await owner.until(
      (m) => m.event?.method === "opencode/event" && m.event.params.event.type === "session.idle",
    );
    expect(await f.text(chapter)).toBe("Hello team\n");
    expect(owner.messages.some((m) => m.event?.method === CHANGES_EVENT)).toBe(true);
    expect(owner.messages.filter((m) => "busy" in m).at(-1).busy).toBeNull();
    const versions = (await f.call(`/projects/${f.project}/snapshots`, undefined, f.owner)).data;
    expect(versions.map((v: { label: string }) => v.label)).toContain("AI 对话修改前");

    // Another editor sees nothing of a hidden session, then the shared one.
    await owner.request("thread.share", { threadId: session.id, shared: false });
    const editor = await f.browser(await f.invite("editor", "editor2"));
    expect(JSON.parse((await call("GET", "/session", undefined, editor)).body)).toEqual([]);
    await expect(call("GET", `/session/${session.id}/message`, undefined, editor)).rejects.toThrow(
      /不存在或未共享/,
    );
    await owner.request("thread.share", { threadId: session.id, shared: true });
    const listed = JSON.parse((await call("GET", "/session", undefined, editor)).body);
    expect(listed).toMatchObject([{ id: session.id, writer: { mine: false, shared: true } }]);
    await expect(
      call("PATCH", `/session/${session.id}`, { title: "mine" }, editor),
    ).rejects.toThrow(/发起人/);

    // Shown in another project: listed and read from its own project's copy, continued only there.
    const second = (await f.call("/projects", { name: "second-paper" }, f.owner)).data.id as string;
    await owner.request("thread.link", { threadId: session.id, project: second });
    const there = client(`${f.origin.replace("http:", "ws:")}/api/projects/${second}/agents`, {
      Cookie: f.owner,
      Origin: f.origin,
    });
    await there.opened;
    expect(JSON.parse((await call("GET", "/session", undefined, there)).body)).toMatchObject([
      {
        id: session.id,
        writer: { mine: false, linkedFrom: { id: f.project, name: "test-paper" } },
      },
    ]);
    expect((await call("GET", `/session/${session.id}/message`, undefined, there)).status).toBe(
      200,
    );
    await expect(
      call("POST", `/session/${session.id}/prompt_async`, { parts: [] }, there),
    ).rejects.toThrow(/只能查看/);
  });
});
