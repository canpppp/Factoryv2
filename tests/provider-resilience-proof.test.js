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
    const restarted = createChannelRegistry({ root, definitionsPath: fixture.definitionsPath, adapterFactory: () => adapter(async (prompt) => {
      calls += 1;
      return receiptFromPrompt(prompt);
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
    startThread: () => ({ run: async (prompt, hooks) => { started += 1; hooks.onThreadId("new-session"); return receiptFromPrompt(prompt); } }),
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

function receiptFromPrompt(prompt) {
  const channelId = prompt.match(/^CHANNEL ([^\n]+)/m)?.[1];
  const jobId = prompt.match(/^JOB ([^\n]+)/m)?.[1];
  const hashes = [...prompt.matchAll(/"sha256":"([0-9a-f]{64})"/g)].map((match) => match[1]);
  const manifestSha = hashes.at(-1);
  return receipt(JSON.stringify({
    done: true,
    channelId,
    jobId,
    summary: "recovered",
    evidence: [],
    contextManifestSha256: manifestSha
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
