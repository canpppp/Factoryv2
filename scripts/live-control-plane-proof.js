#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const journal = require("../src/journal");
const { createChannelRegistry } = require("../src/channels");
const { createChannelTools } = require("../src/jarvis-tools");
const { createCodexAdapter } = require("../src/adapters/codex");

const args = process.argv.slice(2);
const root = path.resolve(args.find((arg) => !arg.startsWith("--")) || ".factoryv2-live-proof");
const repo = path.resolve(__dirname, "..");
const skipClaude = args.includes("--skip-claude");

async function main() {
  const first = createChannelRegistry({ root });
  first.ensureDefaults();
  journal.append(root, { type: "channel.updated", channelId: "kaylas-store", patch: { cwd: repo, readWriteProfile: "read-only", allowedTools: ["Read", "Glob", "Grep"] } });
  let sessionId = first.status("kaylas-store").sessionId;
  if (!skipClaude) {
    first.send("kaylas-store", "Read package.json and report only the package name and one-sentence purpose. Do not edit files.", { kind: "inventory" });
    const started = await first.runNext();
    requireOk(started, "Claude start");
    sessionId = first.status("kaylas-store").sessionId;
    if (!sessionId) throw new Error("Claude session ID was not persisted");
  }

  const restarted = createChannelRegistry({ root });
  if (!skipClaude) {
    restarted.send("kaylas-store", "Using the same session, report the exact npm test command from package.json. Do not edit files.", { kind: "inventory" });
    const resumed = await restarted.runNext();
    requireOk(resumed, "Claude resume");
    if (restarted.status("kaylas-store").sessionId !== sessionId) throw new Error("Claude session changed during resume");
  }

  const tools = createChannelTools(restarted);
  await tools["channel.send"]({ channelId: "invoice-audit", prompt: "Compare controlled invoice fixture", deterministic: { kind: "invoice-compare", records: [{ invoiceId: "proof", amount: 10 }, { invoiceId: "proof", amount: 11 }] } });
  requireOk(await restarted.runNext(), "invoice deterministic lane");
  const invoiceResult = await tools["channel.result"]({ channelId: "invoice-audit" });
  if (!invoiceResult?.deterministic) throw new Error("JARVIS channel result was not retrievable");

  await tools["channel.send"]({ channelId: "facebook-product-launches", prompt: "Evaluate controlled checklist", deterministic: { kind: "campaign-checklist", items: [{ name: "creative", complete: true }] } });
  requireOk(await restarted.runNext(), "campaign deterministic lane");

  const codex = createCodexAdapter({ timeoutMs: 180000 });
  const codexReceipt = await codex.startThread({ cwd: repo, readOnly: true, model: "gpt-5.6-luna" }).run("Read package.json. Reply with only its package name. Do not edit files.");
  if (!/factoryv2/i.test(codexReceipt.finalResponse)) throw new Error("live Codex adapter returned an unexpected result");
  journal.append(root, { type: "adapter.live-proof", engine: "codex", receipt: { sessionId: codexReceipt.sessionId, metadata: codexReceipt.metadata } });

  runDaemonOnce();
  runDaemonOnce();
  const state = journal.load(root);
  const summary = {
    root,
    claudeSessionId: sessionId,
    claudeResumed: state.events.some((event) => event.type === "token.usage" && event.scope.startsWith("channel:kaylas-store") && event.reusedSession),
    exercisedChannels: [...new Set(state.events.filter((event) => event.type === "channel.job.finished").map((event) => event.channelId))],
    daemonPids: [...new Set(state.events.filter((event) => event.type === "daemon.started").map((event) => event.pid))],
    codexSessionId: codexReceipt.sessionId
  };
  console.log(JSON.stringify(summary, null, 2));
}

function runDaemonOnce() {
  const result = spawnSync(process.execPath, [path.join(repo, "bin/factoryd.js"), "--once", "--root", root, "--engine", "claude"], { cwd: repo, encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) throw new Error(`factoryd --once failed: ${result.stderr || result.stdout}`);
}

function requireOk(value, label) {
  if (!value?.result?.ok) throw new Error(`${label} failed: ${value?.result?.error || value?.summary || "unknown"}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
