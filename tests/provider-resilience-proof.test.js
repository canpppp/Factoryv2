"use strict";

const assert = require("node:assert");
const { createChannelRegistry } = require("../src/channels");
const journal = require("../src/journal");
const H = require("./helpers");

async function main() {
  for (const code of ["PROVIDER_QUOTA", "TIMEOUT", "AUTH_REQUIRED", "AGENT_FAILED"]) {
    const root = H.tmp(`factoryv2-${code.toLowerCase()}-`);
    const fixture = H.makeChannelDefinitions();
    let calls = 0;
    const failing = createChannelRegistry({ root, definitionsPath: fixture.definitionsPath, adapterFactory: () => adapter(async () => {
      calls += 1;
      const error = new Error(code);
      error.code = code;
      throw error;
    }) });
    failing.ensureDefaults();
    failing.send("kaylas-store", "Keep this durable", { jobId: `job-${code}` });
    const deferred = await failing.runNext();
    assert.strictEqual(deferred.backoff, true);
    assert.strictEqual(failing.status("kaylas-store").currentJob.id, `job-${code}`);
    assert.strictEqual(failing.status("kaylas-store").lastFailure.recoverable, true);

    journal.append(root, { type: "provider.backoff.cleared", provider: "claude" });
    const restarted = createChannelRegistry({ root, definitionsPath: fixture.definitionsPath, adapterFactory: () => adapter(async () => {
      calls += 1;
      return receipt("recovered");
    }) });
    const recovered = await restarted.runNext();
    assert.strictEqual(recovered.result.ok, true);
    assert.strictEqual(calls, 2);
    assert.strictEqual(journal.load(root).events.filter((event) => event.type === "channel.job.queued").length, 1);
  }

  const staleRoot = H.tmp("factoryv2-stale-session-");
  const staleFixture = H.makeChannelDefinitions();
  let resumed = 0;
  let started = 0;
  const stale = createChannelRegistry({ root: staleRoot, definitionsPath: staleFixture.definitionsPath, adapterFactory: () => ({
    engine: "claude",
    startThread: () => ({ run: async (_prompt, hooks) => { started += 1; hooks.onThreadId("new-session"); return receipt("fresh"); } }),
    resumeThread: () => ({ run: async () => { resumed += 1; const error = new Error("stale"); error.code = "THREAD_NOT_FOUND"; throw error; } }),
    cancelThread: () => false
  }) });
  stale.ensureDefaults();
  journal.append(staleRoot, { type: "channel.session", channelId: "kaylas-store", sessionId: "stale-session", engine: "claude" });
  stale.send("kaylas-store", "Resume safely", { jobId: "stale-job" });
  assert.strictEqual((await stale.runNext()).retry, true);
  assert.strictEqual((await stale.runNext()).result.ok, true);
  assert.strictEqual(resumed, 1);
  assert.strictEqual(started, 1);

  const malformedRoot = H.tmp("factoryv2-malformed-");
  const malformedFixture = H.makeChannelDefinitions();
  const malformed = createChannelRegistry({ root: malformedRoot, definitionsPath: malformedFixture.definitionsPath, adapterFactory: () => adapter(async () => receipt("")) });
  malformed.ensureDefaults();
  malformed.send("kaylas-store", "Reject empty output", { jobId: "malformed" });
  const failed = await malformed.runNext();
  assert.strictEqual(failed.result.code, "MALFORMED_RESPONSE");
  assert.strictEqual(malformed.status("kaylas-store").state, "blocked");

  console.log("Provider outage, stale session, restart and malformed response proof passed");
}

function adapter(run) {
  return {
    engine: "claude",
    startThread: () => ({ run }),
    resumeThread: () => ({ run }),
    cancelThread: () => false
  };
}

function receipt(finalResponse) {
  return { engine: "claude", sessionId: "session", finalResponse, metadata: { model: "test", inputTokens: 10, outputTokens: 2 } };
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
