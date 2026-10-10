/**
 * Shared text keeps "\n" only. Editors count "\r\n" as one character and Yjs as two, so a single
 * "\r" shifted every later edit, comment and AI change on the lab server, whose Windows checkout
 * turned the templates into "\r\n" files.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { sql } from "./db";
import { fixture } from "./test-fixture";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("line endings in shared text", () => {
  it("stores uploads, replacements and templates with \\n only", async () => {
    const templates = await mkdtemp(join(tmpdir(), "writer-crlf-templates-"));
    dirs.push(templates);
    await mkdir(join(templates, "windows"));
    await writeFile(
      join(templates, "windows", "template.json"),
      JSON.stringify({
        name: { zh: "Windows", en: "Windows" },
        main: "main.tex",
        engine: "pdflatex",
      }),
    );
    await writeFile(join(templates, "windows", "main.tex"), "\\section{A}\r\nText\r\n");
    const f = await fixture({ templatesDirectory: templates });
    const api = (path: string, body?: unknown, method?: string) =>
      f.call(`/projects/${f.project}${path}`, body, f.owner, method);
    const read = async (project: string, id: string) =>
      (await f.call(`/projects/${project}/files/${id}`, undefined, f.owner)).data.content;

    const upload = (await api("/files", { path: "win.tex", content: "one\r\ntwo\rthree\r\n" }))
      .data;
    expect(await read(f.project, upload.id)).toBe("one\ntwo\nthree\n");
    await api(
      `/files/${upload.id}`,
      { expected: "one\ntwo\nthree\n", content: "1\r\n2\r\n" },
      "PUT",
    );
    expect(await read(f.project, upload.id)).toBe("1\n2\n");

    const created = (
      await f.call("/projects", { name: "from windows", template: "windows" }, f.owner)
    ).data.id as string;
    const files = (await f.call(`/projects/${created}/files`, undefined, f.owner)).data;
    expect(await read(created, files.find((x: { path: string }) => x.path === "main.tex").id)).toBe(
      "\\section{A}\nText\n",
    );
  });

  it("fixes documents saved with \\r\\n when they open, and edits that bring \\r in", async () => {
    const f = await fixture();
    // A document stored before line endings were normalized.
    const id = "crlf-file";
    const old = new Y.Doc();
    old.getText("content").insert(0, "a\r\nb\rc\n");
    await f.app.store.db.run(
      sql`INSERT INTO files(id, project, path, state, is_binary)
          VALUES(${id}, ${f.project}, 'old.tex', ${Y.encodeStateAsUpdate(old)}, false)`,
    );
    const first = await f.peer(f.owner, id);
    expect(first.doc.getText("content").toString()).toBe("a\nb\nc\n");

    // An editor (an older desktop sync) sends text with "\r\n": everyone converges on "\n".
    const second = await f.peer(f.owner, id);
    const text = first.doc.getText("content");
    first.send(
      "u1",
      first.capture(() => text.insert(text.length, "x\r\ny")),
    );
    await first.next("ack");
    // The other editor gets the edit and then the server's correction.
    const shared = () => second.doc.getText("content").toString();
    for (let i = 0; i < 4 && shared() !== "a\nb\nc\nx\ny"; i++) {
      const message = await second.next("update");
      Y.applyUpdate(second.doc, Buffer.from(message.update ?? "", "base64"));
    }
    expect(shared()).toBe("a\nb\nc\nx\ny");
    const stored = await f.call(`/projects/${f.project}/files/${id}`, undefined, f.owner);
    expect(stored.data.content).toBe("a\nb\nc\nx\ny");
  });
});
