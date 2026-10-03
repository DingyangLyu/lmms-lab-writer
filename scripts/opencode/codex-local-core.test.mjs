import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildModels, codexFetch, readCodexAuth } from "./codex-local-core.mjs";

test("preserves exact model IDs and excludes hidden/internal catalog entries", () => {
  const models = buildModels({
    models: [
      { slug: "gpt-6-astra", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] },
      { slug: "private-review", visibility: "hide" },
    ],
  });
  assert.deepEqual(Object.keys(models), ["gpt-6-astra"]);
  assert.equal(models["gpt-6-astra"].id, "gpt-6-astra");
});

test("rereads auth each request without rewriting the requested model", async () => {
  let revision = 0;
  const sent = [];
  const fetch = codexFetch({
    getAuth: async () => ({ access: `token${++revision}`, accountId: "test" }),
    request: async (url, init) => {
      sent.push({ url, init });
      return Response.json({});
    },
  });
  for (let i = 0; i < 2; i++)
    await fetch("https://chatgpt.com/backend-api/codex/responses", {
      body: JSON.stringify({ model: "gpt-6-astra", input: [], max_output_tokens: 128 }),
    });
  assert.equal(sent[0].init.headers.get("authorization"), "Bearer token1");
  assert.equal(sent[1].init.headers.get("authorization"), "Bearer token2");
  assert.equal(sent[1].init.redirect, "error");
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.model, "gpt-6-astra");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, undefined);
});

test("never sends credentials to a different endpoint", async () => {
  const fetch = codexFetch({
    getAuth: async () => {
      throw new Error("must not read credentials");
    },
  });
  await assert.rejects(fetch("https://example.com/responses"), /official Codex/);
});

test("reads valid local ChatGPT auth and rejects expired tokens", async () => {
  const home = await mkdtemp(join(tmpdir(), "writer-codex-test-"));
  try {
    const data = {
      auth_mode: "chatgpt",
      tokens: { access_token: "opaque-test-token", account_id: "test-account" },
    };
    await writeFile(join(home, "auth.json"), JSON.stringify(data));
    assert.equal((await readCodexAuth(home)).accountId, "test-account");
    data.tokens.access_token = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
    await writeFile(join(home, "auth.json"), JSON.stringify(data));
    await assert.rejects(readCodexAuth(home), /已过期/);
  } finally {
    await rm(home, { recursive: true });
  }
});
