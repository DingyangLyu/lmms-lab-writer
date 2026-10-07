import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWriterServer } from "./app";
import { parseLog } from "./compile";

// Excerpt of a real pdflatex log (TeX Live 2026, -file-line-error).
const LOG = `LaTeX Font Info:    ... okay on input line 2.

LaTeX Warning: Reference \`sec:missing' on page 1 undefined on input line 3.

./main.tex:4: Undefined control sequence.
l.4 \\undefinedcommand
                      here
The control sequence at the end of the top line
of your error message was never \\def'ed.
/usr/share/texlive/texmf-dist/tex/latex/base/article.cls:12: Fake class error.

LaTeX Warning: There were undefined references.
`;

describe("TeX log", () => {
  it("extracts errors with project-relative locations and warnings", () => {
    expect(parseLog(LOG, "/tmp/build")).toEqual([
      {
        level: "warning",
        file: null,
        line: 3,
        message: "Reference `sec:missing' on page 1 undefined on input line 3.",
      },
      { level: "error", file: "main.tex", line: 4, message: "Undefined control sequence." },
      { level: "error", file: null, line: 12, message: "Fake class error." },
      { level: "warning", file: null, line: null, message: "There were undefined references." },
    ]);
  });
});

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "writer-compile-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
/** Stands in for latexmk: writes the outputs a real build leaves in build-output/. */
async function fakeLatexmk() {
  const fixture = join(import.meta.dirname, "fixtures/sample-synctex.gz");
  const script = join(dir, "latexmk");
  await writeFile(
    script,
    `#!/bin/sh
for a; do main="$a"; done
stem=$(basename "$main" .tex)
mkdir -p build-output
[ "$stem" = slow ] && sleep 1
printf '%%PDF-1.4 fake\\n' > "build-output/$stem.pdf"
gunzip -c "${fixture}" | sed "s#/tmp/writer-build-fixture#$(pwd -P)#g" | gzip > "build-output/$stem.synctex.gz"
printf './main.tex:4: Undefined control sequence.\\nl.4 \\\\bad\\n' > "build-output/$stem.log"
exit 12
`,
  );
  await chmod(script, 0o755);
  return script;
}
async function server(latexmk: string) {
  const app = await createWriterServer({
    databaseUrl: "pglite:memory",
    port: 0,
    adminUser: "owner",
    adminPassword: "test-password-1234",
    compile: { latexmk, timeoutMs: 20_000 },
  });
  const call = async (path: string, body?: unknown, cookie = "") => {
    const r = await fetch(`${app.origin}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: app.origin, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = r.headers.get("content-type") ?? "";
    return {
      status: r.status,
      data: type.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer()),
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  const cookie = (await call("/login", { username: "owner", password: "test-password-1234" }))
    .cookie;
  const project = (await call("/projects", { name: "paper" }, cookie)).data.id;
  for (const [path, content] of [
    ["main.tex", "\\documentclass{article}\n\\begin{document}\nHi\n\\bad\n\\end{document}\n"],
    ["slow.tex", "x"],
  ])
    await call(`/projects/${project}/files`, { path, content }, cookie);
  return { app, call, cookie, project };
}

describe.skipIf(process.platform === "win32")("server builds", () => {
  it("builds, keeps the PDF and answers SyncTeX queries", async () => {
    const s = await server(await fakeLatexmk());
    try {
      const prefix = `/projects/${s.project}`;
      const build = await s.call(
        `${prefix}/builds`,
        { main: "main.tex", engine: "pdflatex" },
        s.cookie,
      );
      expect(build.status).toBe(200);
      expect(build.data).toMatchObject({ status: "failed", pdf: true, main: "main.tex" });
      expect(build.data.issues[0]).toMatchObject({ file: "main.tex", line: 4 });
      const latest = await s.call(`${prefix}/builds/latest`, undefined, s.cookie);
      expect(latest.data.id).toBe(build.data.id);
      const pdf = await s.call(`${prefix}/builds/${build.data.id}/pdf`, undefined, s.cookie);
      expect(Buffer.from(pdf.data as Uint8Array).toString()).toContain("%PDF");
      const forward = await s.call(
        `${prefix}/builds/${build.data.id}/forward?file=main.tex&line=5`,
        undefined,
        s.cookie,
      );
      expect(forward.data.page).toBe(1);
      const inverse = await s.call(
        `${prefix}/builds/${build.data.id}/inverse?page=1&x=${forward.data.x + 5}&y=${forward.data.y + forward.data.height / 2}`,
        undefined,
        s.cookie,
      );
      expect(inverse.data).toEqual({ file: "main.tex", line: 5 });
      expect(
        (await s.call(`${prefix}/builds`, { main: "nope.tex", engine: "pdflatex" }, s.cookie))
          .status,
      ).toBe(404);
      expect(
        (await s.call(`${prefix}/builds`, { main: "main.tex", engine: "bash" }, s.cookie)).status,
      ).toBe(400);
      const [first, second] = await Promise.all([
        s.call(`${prefix}/builds`, { main: "slow.tex", engine: "xelatex" }, s.cookie),
        new Promise((r) => setTimeout(r, 200)).then(() =>
          s.call(`${prefix}/builds`, { main: "main.tex", engine: "pdflatex" }, s.cookie),
        ),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
    } finally {
      await s.app.close();
    }
  });
  it("explains a missing TeX installation", async () => {
    const s = await server(join(dir, "no-such-latexmk"));
    try {
      const r = await s.call(
        `/projects/${s.project}/builds`,
        { main: "main.tex", engine: "pdflatex" },
        s.cookie,
      );
      expect(r.status).toBe(503);
      expect(r.data.error).toContain("TeX");
    } finally {
      await s.app.close();
    }
  });
  // Opt-in end-to-end check with a real TeX installation: WRITER_TEST_LATEXMK=/path/latexmk.
  it.skipIf(!process.env.WRITER_TEST_LATEXMK)(
    "compiles with real TeX",
    async () => {
      const s = await server(process.env.WRITER_TEST_LATEXMK ?? "");
      try {
        await s.call(
          `/projects/${s.project}/files`,
          {
            path: "sections/intro.tex",
            content: "Introduction text on the first line.\n",
          },
          s.cookie,
        );
        const files = (await s.call(`/projects/${s.project}/files`, undefined, s.cookie)).data;
        const main = files.find((f: { path: string }) => f.path === "main.tex");
        const doc = await s.call(`/projects/${s.project}/files/${main.id}`, undefined, s.cookie);
        await fetch(`${s.app.origin}/api/projects/${s.project}/files/${main.id}`, {
          method: "PUT",
          headers: { Origin: s.app.origin, Cookie: s.cookie },
          body: JSON.stringify({
            expected: doc.data.content,
            content:
              "\\documentclass{article}\n\\begin{document}\n\\section{One}\\label{s}\n\\input{sections/intro}\n\\end{document}\n",
          }),
        });
        const build = await s.call(
          `/projects/${s.project}/builds`,
          { main: "main.tex", engine: "pdflatex" },
          s.cookie,
        );
        expect(build.data).toMatchObject({ status: "success", pdf: true });
        const forward = await s.call(
          `/projects/${s.project}/builds/${build.data.id}/forward?file=sections/intro.tex&line=1`,
          undefined,
          s.cookie,
        );
        expect(forward.data.page).toBe(1);
      } finally {
        await s.app.close();
      }
    },
    120_000,
  );
});
