"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const audit = require("../src/audit");
const journal = require("../src/journal");
const H = require("./helpers");

function main() {
  const items = audit.productionAudit();
  assert.strictEqual(items.length, 9);
  assert.deepStrictEqual(items.map((x) => x.id), "ABCDEFGHI".split(""));
  assert.ok(items.some((x) => x.id === "A" && x.status === "implemented"));
  assert.ok(items.some((x) => x.id === "F" && x.status === "protocol-proved"));

  const root = H.tmp("factoryv2-audit-");
  const r = spawnSync(process.execPath, [path.join(__dirname, "../bin/factoryv2.js"), "--root", root, "audit"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /A\. IMPLEMENTED normal run uses a real adapter/);
  assert.match(r.stdout, /F\. PROTOCOL-PROVED compact goal and selective skills/);

  const unrelated = H.tmp("factoryv2-audit-unrelated-");
  journal.append(unrelated, { type: "daemon.started", pid: 101 });
  journal.append(unrelated, { type: "daemon.started", pid: 102 });
  journal.append(unrelated, { type: "channel.job.queued", channelId: "a", job: { id: "job-a" } });
  journal.append(unrelated, { type: "channel.job.finished", channelId: "b", jobId: "job-b", result: { ok: true, deterministic: true } });
  journal.append(unrelated, { type: "token.usage", scope: "channel:x:y", reusedSession: true, promptContextEstimate: 1, cacheReadTokens: 0, origin: "fixture" });
  journal.append(unrelated, { type: "provider.backoff.scheduled", provider: "claude", scenarioId: "quota-a" });
  const falseGreen = audit.productionAudit(unrelated).filter((item) => "ABCEGH".includes(item.id) && item.status === "live-proved");
  assert.deepStrictEqual(falseGreen, []);

  const fixtureOnly = H.tmp("factoryv2-audit-fixture-only-");
  journal.append(fixtureOnly, { type: "channel.job.queued", channelId: "jarvis-development", job: { id: "job-fixture" }, origin: "fixture" });
  journal.append(fixtureOnly, { type: "channel.context.resolved", channelId: "jarvis-development", jobId: "job-fixture", origin: "fixture", manifest: { sha256: "a".repeat(64), refs: [{ ref: "capsule", kind: "sop", sha256: "b".repeat(64), bytes: 12 }] } });
  journal.append(fixtureOnly, { type: "channel.job.finished", channelId: "jarvis-development", jobId: "job-fixture", result: { ok: true, verified: true }, origin: "fixture" });
  journal.append(fixtureOnly, { type: "channel.result.retrieved", channelId: "jarvis-development", jobId: "job-fixture", ok: true, verified: true, origin: "fixture" });
  const fixtureStatuses = new Map(audit.productionAudit(fixtureOnly).map((item) => [item.id, item.status]));
  assert.notStrictEqual(fixtureStatuses.get("E"), "live-proved");
  assert.notStrictEqual(fixtureStatuses.get("F"), "live-proved");

  const omittedOrigin = H.tmp("factoryv2-audit-omitted-origin-");
  journal.append(omittedOrigin, { type: "channel.job.queued", channelId: "jarvis-development", job: { id: "job-unmarked" } });
  journal.append(omittedOrigin, { type: "channel.context.resolved", channelId: "jarvis-development", jobId: "job-unmarked", manifest: { sha256: "a".repeat(64), refs: [{ ref: "capsule", kind: "sop", sha256: "b".repeat(64), bytes: 12 }] } });
  journal.append(omittedOrigin, { type: "channel.job.finished", channelId: "jarvis-development", jobId: "job-unmarked", result: { ok: true, verified: true } });
  journal.append(omittedOrigin, { type: "channel.result.retrieved", channelId: "jarvis-development", jobId: "job-unmarked", ok: true, verified: true });
  const omittedStatuses = new Map(audit.productionAudit(omittedOrigin).map((item) => [item.id, item.status]));
  assert.notStrictEqual(omittedStatuses.get("D"), "live-proved");
  assert.notStrictEqual(omittedStatuses.get("E"), "live-proved");
  assert.notStrictEqual(omittedStatuses.get("F"), "live-proved");

  const quota = H.tmp("factoryv2-audit-quota-");
  journal.append(quota, { type: "provider.backoff.scheduled", provider: "claude", scenarioId: "quota-a", origin: "live" });
  journal.append(quota, { type: "deterministic.continuation", scenarioId: "quota-a", channelId: "invoice-audit", jobId: "job-q", origin: "live" });
  assert.strictEqual(new Map(audit.productionAudit(quota).map((item) => [item.id, item.status])).get("H"), "live-proved");
  const omittedQuota = H.tmp("factoryv2-audit-omitted-quota-");
  journal.append(omittedQuota, { type: "provider.backoff.scheduled", provider: "claude", scenarioId: "quota-a" });
  journal.append(omittedQuota, { type: "deterministic.continuation", scenarioId: "quota-a", channelId: "invoice-audit", jobId: "job-q" });
  assert.notStrictEqual(new Map(audit.productionAudit(omittedQuota).map((item) => [item.id, item.status])).get("H"), "live-proved");

  const earlyRetrieval = H.tmp("factoryv2-audit-early-retrieval-");
  journal.append(earlyRetrieval, { type: "channel.job.queued", channelId: "jarvis-development", job: { id: "job-early" } });
  journal.append(earlyRetrieval, { type: "channel.result.retrieved", channelId: "jarvis-development", jobId: "job-early", ok: false, verified: false });
  journal.append(earlyRetrieval, { type: "channel.job.finished", channelId: "jarvis-development", jobId: "job-early", result: { ok: true, verified: true } });
  assert.notStrictEqual(new Map(audit.productionAudit(earlyRetrieval).map((item) => [item.id, item.status])).get("E"), "live-proved");

  const scoped = H.tmp("factoryv2-audit-scoped-");
  journal.append(scoped, { type: "channel.job.queued", channelId: "jarvis-development", job: { id: "job-1" }, origin: "factoryv2" });
  journal.append(scoped, { type: "agent.receipt", channelId: "jarvis-development", jobId: "job-1", sessionId: "session-1", engine: "claude", origin: "live" });
  journal.append(scoped, { type: "channel.context.resolved", channelId: "jarvis-development", jobId: "job-1", origin: "factoryv2", manifest: { sha256: "a".repeat(64), refs: [{ ref: "capsule", kind: "sop", sha256: "b".repeat(64), bytes: 12 }] } });
  journal.append(scoped, { type: "token.usage", scope: "channel:jarvis-development:job-1", reusedSession: true, promptContextEstimate: 4, cacheReadTokens: 1, origin: "live" });
  journal.append(scoped, { type: "channel.job.finished", channelId: "jarvis-development", jobId: "job-1", result: { ok: true, verified: true }, origin: "factoryv2" });
  journal.append(scoped, { type: "channel.result.retrieved", channelId: "jarvis-development", jobId: "job-1", ok: true, verified: true, origin: "factoryv2" });
  const proved = new Map(audit.productionAudit(scoped).map((item) => [item.id, item.status]));
  assert.strictEqual(proved.get("A"), "live-proved");
  assert.strictEqual(proved.get("C"), "live-proved");
  assert.strictEqual(proved.get("E"), "live-proved");
  assert.strictEqual(proved.get("F"), "live-proved");
  assert.strictEqual(proved.get("G"), "live-proved");

  console.log("Truthful control-plane audit proof passed");
}

try {
  main();
} catch (e) {
  console.error(e.stack || e.message);
  process.exit(1);
}
