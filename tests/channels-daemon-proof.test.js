"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { createClaudeAdapter } = require("../src/adapters/claude");
const { createCodexAdapter } = require("../src/adapters/codex");
const { createChannelRegistry } = require("../src/channels");
const { createChannelTools } = require("../src/jarvis-tools");
const { createDaemon, notificationFor, NOTIFICATION_TYPES } = require("../src/daemon");
const { plist } = require("../src/launchd");
const journal = require("../src/journal");
const H = require("./helpers");

const fixture = path.join(__dirname, "fixtures/agent-cli.js");
const adapterFactory = ({ engine, ...config }) => engine === "codex"
  ? createCodexAdapter({ ...config, command: fixture })
  : createClaudeAdapter({ ...config, command: fixture });

async function main() {
  const root = H.tmp("factoryv2-channels-");
  const fixtureConfig = H.makeChannelDefinitions();
  const registry = createChannelRegistry({ root, adapterFactory, definitionsPath: fixtureConfig.definitionsPath });
  assert.strictEqual(registry.ensureDefaults().length, 6);
  assert.strictEqual(registry.status("store-two").id, "esmebelle-store");
  assert.ok(!registry.list().some((channel) => channel.id === "store-two"));

  registry.send("kaylas-store", "Investigate yesterday's refund spike.");
  await registry.runNext();
  const firstSession = registry.status("kaylas-store").sessionId;
  assert.match(firstSession, /^[0-9a-f-]{36}$/);

  const restarted = createChannelRegistry({ root, adapterFactory, definitionsPath: fixtureConfig.definitionsPath });
  restarted.send("kaylas-store", "Summarize the evidence.");
  await restarted.runNext();
  assert.strictEqual(restarted.status("kaylas-store").sessionId, firstSession, "restart did not resume exact Claude session");

  restarted.send("quality-check", "Review the refund-spike result.");
  await restarted.runNext();
  restarted.send("invoice-audit", "Compare these invoice records.", {
    deterministic: { kind: "invoice-compare", records: [{ invoiceId: "A", amount: 10 }, { invoiceId: "A", amount: 12 }] }
  });
  await restarted.runNext();
  assert.strictEqual(restarted.result("quality-check").ok, true);
  assert.strictEqual(restarted.result("invoice-audit").deterministic, true);
  assert.strictEqual(restarted.result("invoice-audit").mismatches.length, 1);

  const primed = restarted.send("kaylas-store", "Use the store SOP to answer.", {
    jobId: "primed-job",
    jobPackId: "kaylas-store:ops-pack",
    jobPackRevision: "7",
    primingRefs: ["capsule"],
    contextRefs: ["skill:channel-operator"],
    evidenceRequired: ["capsule"]
  });
  assert.strictEqual(primed.envelope.jobPackId, "kaylas-store:ops-pack");
  assert.deepStrictEqual(primed.envelope.primingRefs, ["capsule"]);
  assert.ok(primed.envelope.payloadDigest);
  await restarted.runNext();
  const primedResult = restarted.result("kaylas-store", "primed-job");
  assert.strictEqual(primedResult.verified, true);
  const contextEvent = journal.load(root).events.find((event) => event.type === "channel.context.resolved" && event.jobId === "primed-job");
  assert.strictEqual(contextEvent.manifest.jobPackId, "kaylas-store:ops-pack");
  assert.ok(contextEvent.manifest.sha256);
  assert.ok(contextEvent.manifest.refs.some((ref) => ref.ref === "capsule" && ref.kind === "sop" && ref.bytes > 0));

  const tools = createChannelTools(restarted);
  const queued = await tools["channel.send"]({ channelId: "facebook-product-launches", prompt: "Pause and report campaign state." });
  assert.ok(queued.id);
  assert.strictEqual((await tools["channel.status"]({ channelId: "facebook-product-launches" })).queued, 1);
  await restarted.runNext();
  assert.strictEqual((await tools["channel.result"]({ channelId: "facebook-product-launches" })).ok, true);

  restarted.send("store-two", "Queue then cancel this read-only job.");
  const cancelled = await tools["channel.cancel"]({ channelId: "store-two" });
  assert.strictEqual(cancelled.id, "esmebelle-store");
  assert.strictEqual(cancelled.operation.accepted, true);
  assert.strictEqual(cancelled.operation.changed, true);
  assert.ok(cancelled.operation.jobId);
  const noOpCancel = await tools["channel.cancel"]({ channelId: "store-two" });
  assert.strictEqual(noOpCancel.operation.changed, false);

  restarted.pause("kaylas-store");
  const resumed = await tools["channel.resume"]({ channelId: "kaylas-store" });
  assert.strictEqual(resumed.operation.changed, true);
  assert.strictEqual(resumed.operation.action, "resume");

  const usage = journal.load(root).events.filter((event) => event.type === "token.usage");
  assert.ok(usage.length >= 4);
  assert.ok(usage.some((event) => event.reusedSession === true));
  for (const event of usage) {
    assert.ok(Object.hasOwn(event, "model"));
    assert.ok(Object.hasOwn(event, "promptContextEstimate"));
    assert.ok(Object.hasOwn(event, "outputBytes"));
    assert.ok(Object.hasOwn(event, "cacheReadTokens"));
    assert.ok(Object.hasOwn(event, "escalationReason"));
  }

  const daemonRoot = H.tmp("factoryv2-daemon-");
  const daemon1 = createDaemon({ root: daemonRoot, adapterFactory, pollMs: 1, channelDefinitionsPath: fixtureConfig.definitionsPath });
  daemon1.channels.ensureDefaults();
  daemon1.channels.send("kaylas-store", "First daemon turn.");
  await daemon1.runOnce();
  const daemonSession = daemon1.channels.status("kaylas-store").sessionId;
  const daemon2 = createDaemon({ root: daemonRoot, adapterFactory, pollMs: 1, channelDefinitionsPath: fixtureConfig.definitionsPath });
  daemon2.channels.send("kaylas-store", "Resumed after daemon restart.");
  await daemon2.runOnce();
  assert.strictEqual(daemon2.channels.status("kaylas-store").sessionId, daemonSession);

  assert.match(plist({ root: daemonRoot }), /KeepAlive/);
  assert.match(plist({ root: daemonRoot }), /FACTORYV2_HOME/);
  const boundPlist = plist({ root: daemonRoot, channelRoots: { FACTORYV2_KAYLAS_CWD: "/tmp/Kaylas & Co", UNRELATED_SECRET: "never" } });
  assert.match(boundPlist, /FACTORYV2_KAYLAS_CWD/);
  assert.match(boundPlist, /\/tmp\/Kaylas &amp; Co/);
  assert.doesNotMatch(boundPlist, /UNRELATED_SECRET|never/);
  const notification = notificationFor({ type: "receipt", status: "READY_FOR_HUMAN_CHECK", missionId: "m1", summary: "ready" });
  assert.ok(NOTIFICATION_TYPES.has(notification.type));
  assert.strictEqual(notificationFor({ type: "channel.job.finished" }), null);

  await proveWorkerReceivesResolvedContext(fixtureConfig.definitionsPath);

  console.log("Channels and daemon restart proof passed");
}

async function proveWorkerReceivesResolvedContext(definitionsPath) {
  const root = H.tmp("factoryv2-priming-");
  let capturedPrompt = "";
  const adapter = {
    startThread: () => ({
      run: async (prompt, hooks) => {
        capturedPrompt = prompt;
        hooks.onThreadId("priming-session");
        const hashes = [...prompt.matchAll(/"sha256":"([0-9a-f]{64})"/g)].map((match) => match[1]);
        const manifestSha = hashes.at(-1);
        return {
          engine: "claude",
          sessionId: "priming-session",
          finalResponse: JSON.stringify({
            done: true,
            channelId: "kaylas-store",
            jobId: "priming-content-job",
            summary: "context received",
            evidence: ["capsule"],
            contextManifestSha256: manifestSha
          }),
          metadata: {}
        };
      }
    }),
    resumeThread: () => { throw new Error("unexpected resume"); },
    cancelThread: () => false
  };
  const registry = createChannelRegistry({ root, definitionsPath, adapterFactory: () => adapter });
  registry.ensureDefaults();
  registry.send("kaylas-store", "prove priming", { jobId: "priming-content-job", primingRefs: ["capsule"], evidenceRequired: ["capsule"] });
  await registry.runNext();
  assert.match(capturedPrompt, /REQUIRED CONTEXT CONTENT:/);
  assert.match(capturedPrompt, /Test capsule for kaylas-store/);
  assert.strictEqual(registry.result("kaylas-store", "priming-content-job").verified, true);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
