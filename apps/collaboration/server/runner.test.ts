import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir = "";
let executeJob: typeof import("./runner").executeJob;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "writer-runner-test-"));
  const cli = join(dir, "fake-codex.sh");
  // Stands in for a local agent CLI: edits text, deletes a file and drops its own config.
  await writeFile(
    cli,
    '#!/bin/sh\ncat >/dev/null\nprintf "Revised\\n" > main.tex\nprintf "k: 2\\n" > config.yml\nrm notes.md\nprintf "{}" > opencode.json\n',
  );
  await chmod(cli, 0o755);
  process.env.WRITER_ALLOWED_HARNESSES = "codex";
  process.env.WRITER_CODEX_BIN = cli;
  ({ executeJob } = await import("./runner"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
describe.skipIf(process.platform === "win32")("local runner", () => {
  it("reports edited text files, keeps withheld agent config out of the result", async () => {
    const work = await mkdtemp(join(dir, "work-"));
    const result = await executeJob(
      {
        id: "job",
        prompt: "revise",
        harness: "codex",
        files: [
          { id: "1", path: "main.tex", binary: false, content: "Original\n" },
          { id: "2", path: "config.yml", binary: false, content: "k: 1\n" },
          { id: "3", path: "notes.md", binary: false, content: "notes\n" },
          { id: "4", path: "opencode.json", binary: false, content: '{"model":"x"}' },
        ],
      },
      work,
      async () => {},
    );
    expect(result.files).toEqual(
      expect.arrayContaining([
        { path: "main.tex", content: "Revised\n" },
        { path: "config.yml", content: "k: 2\n" },
        { path: "notes.md", content: "" },
      ]),
    );
    expect(result.files.map((f) => f.path)).not.toContain("opencode.json");
    expect(result.files).toHaveLength(3);
  });
  it("gives the agent none of Writer's secrets", async () => {
    const cli = join(dir, "env-codex.sh");
    await writeFile(
      cli,
      '#!/bin/sh\ncat >/dev/null\nprintf "%s|%s|%s" "$WRITER_DATABASE_URL" "$WRITER_SHARED_RUNNER_TOKEN" "$WRITER_RUNNER_TOKEN" > seen.txt\n',
    );
    await chmod(cli, 0o755);
    const saved = { ...process.env };
    Object.assign(process.env, {
      WRITER_CODEX_BIN: cli,
      WRITER_DATABASE_URL: "postgres://writer:secret@db/writer",
      WRITER_SHARED_RUNNER_TOKEN: "f".repeat(64),
      WRITER_RUNNER_TOKEN: "e".repeat(64),
    });
    try {
      const work = await mkdtemp(join(dir, "work-"));
      const result = await executeJob(
        { id: "env", prompt: "x", harness: "codex", files: [] },
        work,
        async () => {},
      );
      expect(result.files).toEqual([{ path: "seen.txt", content: "||" }]);
    } finally {
      process.env = saved;
    }
  });
});
