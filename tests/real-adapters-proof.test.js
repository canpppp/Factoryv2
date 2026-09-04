"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { createClaudeAdapter } = require("../src/adapters/claude");
const { createCodexAdapter, buildArgs } = require("../src/adapters/codex");

const fixture = path.join(__dirname, "fixtures/agent-cli.js");

async function proveClaude() {
  const adapter = createClaudeAdapter({ command: fixture, model: "test-model", maxTurns: 4 });
  let captured;
  const first = await adapter.startThread({
    cwd: __dirname,
    readOnly: true,
    allowedTools: ["Read"],
    disallowedTools: ["WebFetch"]
  }).run("first", { onThreadId: (id) => { captured = id; } });
  assert.match(captured, /^[0-9a-f-]{36}$/);
  assert.strictEqual(first.sessionId, captured);
  assert.strictEqual(first.finalResponse, "claude:first");
  assert.strictEqual(first.metadata.inputTokens, 11);
  assert.strictEqual(first.metadata.cacheReadTokens, 5);
  const resumed = await adapter.resumeThread(captured, { cwd: __dirname, readOnly: true }).run("second");
  assert.strictEqual(resumed.sessionId, captured);
  assert.strictEqual(resumed.finalResponse, "claude:second");

  const timeoutAdapter = createClaudeAdapter({ command: fixture, timeoutMs: 10 });
  const old = process.env.FIXTURE_SLEEP_MS;
  process.env.FIXTURE_SLEEP_MS = "100";
  await assert.rejects(
    timeoutAdapter.startThread({ cwd: __dirname }).run("slow"),
    (error) => error.code === "TIMEOUT"
  );
  if (old === undefined) delete process.env.FIXTURE_SLEEP_MS;
  else process.env.FIXTURE_SLEEP_MS = old;
}

async function proveCodex() {
  assert.ok(buildArgs({ cwd: "/validated/non-git", readOnly: true }).includes("--skip-git-repo-check"));
  const adapter = createCodexAdapter({ command: fixture, model: "test-model" });
  let captured;
  const first = await adapter.startThread({ cwd: __dirname, readOnly: false }).run("first", {
    onThreadId: (id) => { captured = id; }
  });
  assert.strictEqual(captured, "11111111-1111-4111-8111-111111111111");
  assert.strictEqual(first.threadId, captured);
  assert.strictEqual(first.finalResponse, "codex:first");
  assert.strictEqual(first.metadata.outputTokens, 9);
  const resumed = await adapter.resumeThread(captured, { cwd: __dirname }).run("second");
  assert.strictEqual(resumed.threadId, captured);
  assert.strictEqual(resumed.finalResponse, "codex:second");
}

async function main() {
  await proveClaude();
  await proveCodex();
  console.log("Real adapter protocol proof passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
