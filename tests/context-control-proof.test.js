"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createChannelRegistry } = require("../src/channels");
const { route } = require("../src/model-router");
const tokenGovernor = require("../src/token-governor");
const memory = require("../src/memory");
const journal = require("../src/journal");
const H = require("./helpers");

async function main() {
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, "../skills/index.json"), "utf8"));
  assert.strictEqual(index.length, 10);
  for (const entry of index) {
    const text = fs.readFileSync(path.join(__dirname, "../skills", entry.name, "SKILL.md"), "utf8");
    assert.match(text, new RegExp(`name: ${entry.name}`));
    assert.match(text, /Inputs:/);
    assert.match(text, /Outputs:/);
    assert.match(text, /Never /);
    assert.match(text, /Behavior:/);
  }

  assert.strictEqual(route({ kind: "inventory", engine: "codex" }).tier, "luna");
  assert.strictEqual(route({ kind: "implementation", engine: "codex" }).tier, "terra");
  assert.strictEqual(route({ kind: "architecture", engine: "codex" }).tier, "sol");
  assert.strictEqual(route({ kind: "implementation", engine: "codex", failedRepairs: 2 }).tier, "sol-max");
  assert.strictEqual(route({ kind: "architecture", engine: "codex", solAvailable: false }).tier, "terra");

  const root = H.tmp("factoryv2-memory-");
  memory.remember(root, { scope: "kaylas-store", text: "Refund spike came from duplicate fulfillment webhooks.", source: "job-17" });
  const sessionDir = path.join(journal.ensure(root).sessions, "quality-check");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "review.json"), JSON.stringify({
    channelId: "quality-check",
    job: { id: "review", prompt: "Review refund evidence" },
    result: { response: "Duplicate webhook evidence is reproducible." }
  }));
  const hits = memory.search(root, "duplicate refund", { limit: 3 });
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((hit) => hit.excerpt.length < 500));

  const reduction = tokenGovernor.measureReduction({ baseline: "full session ".repeat(1000), compact: "refund webhook capsule" });
  assert.ok(reduction.reductionPercent > 95);

  const quotaRoot = H.tmp("factoryv2-quota-");
  const quotaAdapterFactory = () => ({
    engine: "claude",
    startThread: () => ({ run: async () => { const error = new Error("provider quota exhausted"); error.code = "PROVIDER_QUOTA"; throw error; } }),
    resumeThread: () => ({ run: async () => { const error = new Error("provider quota exhausted"); error.code = "PROVIDER_QUOTA"; throw error; } }),
    cancelThread: () => false
  });
  const registry = createChannelRegistry({ root: quotaRoot, adapterFactory: quotaAdapterFactory });
  registry.ensureDefaults();
  registry.send("kaylas-store", "Architecture task", { kind: "architecture" });
  const deferred = await registry.runNext();
  assert.strictEqual(deferred.backoff, true);
  const state = journal.load(quotaRoot);
  assert.ok(state.providerBackoffs.has("claude"));
  assert.ok(state.events.some((event) => event.type === "provider.fallback.selected" && event.to === "terra"));
  assert.strictEqual(registry.status("kaylas-store").currentJob.prompt, "Architecture task");

  registry.send("invoice-audit", "Compare invoices", { deterministic: { kind: "invoice-compare", records: [] } });
  const continued = await registry.runNext();
  assert.strictEqual(continued.result.deterministic, true, "deterministic work did not continue during provider backoff");

  console.log("Context, skills, routing and quota proof passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
