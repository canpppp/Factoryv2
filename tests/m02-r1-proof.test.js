"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { fixtureProfile } = require("./fixtures/isolated-profile");
const { compileTask } = require("../src/task-compiler");
const H = require("./helpers");

const baseline = process.argv.includes("--baseline");
let adapterRoot = path.resolve(__dirname, "../src/adapters");
if (baseline) {
  adapterRoot = H.tmp("factory-r1-before-");
  for (const file of ["process.js", "worker-policy.js", "owned-thread.js", "claude.js", "codex.js"]) {
    fs.writeFileSync(path.join(adapterRoot, file), execFileSync("git", ["show", `5b05be8cab178a6a551831d6797195240fe0ad34:src/adapters/${file}`]));
  }
}
const { createClaudeAdapter } = require(path.join(adapterRoot, "claude"));
const { createCodexAdapter } = require(path.join(adapterRoot, "codex"));
const option = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;

async function main() {
  const root = H.tmp("factory-r1-data-");
  const read = path.join(root, "read"), other = path.join(root, "other");
  fs.mkdirSync(read); fs.mkdirSync(other);
  const inside = path.join(read, "input"), outside = path.join(other, "input");
  fs.writeFileSync(inside, "allowed"); fs.writeFileSync(outside, "out-of-scope");
  const config = fixtureProfile(path.join(__dirname, "fixtures/policy-access-cli.js"), { readRoots: [root], writeRoots: [root] });
  const adapter = createClaudeAdapter(config);
  const options = { cwd: root, readOnly: true, allowedTools: ["Read"], timeoutMs: 2000 };
  const allowed = adapter.startThread(options);
  const reduced = adapter.startThread({ ...options, disallowedTools: ["Read"] });
  if (baseline) {
    assert.deepEqual(reduced.profile.tools, ["Read"]);
    assert.equal(reduced.profile.digest, allowed.profile.digest);
    adapter.resumeThread("old-session", { ...options, disallowedTools: ["Read"], resumeProfileDigest: allowed.profile.digest });
    console.log("BEFORE R1: denied Read still available; digest unchanged; broader resume accepted (compilation only)");
  } else {
    assert.deepEqual(reduced.profile.tools, []);
    assert.deepEqual(reduced.profile.disallowedTools, ["Read"]);
    assert.notEqual(reduced.profile.digest, allowed.profile.digest);
    assert.throws(() => adapter.resumeThread("old-session", { ...options, disallowedTools: ["Read"], resumeProfileDigest: allowed.profile.digest }), { code: "SESSION_POLICY_CHANGED" });
    assert.throws(() => adapter.startThread({ ...options, disallowedTools: "Read" }), { code: "POLICY_DENIED" });
    assert.throws(() => adapter.startThread({ ...options, disallowedTools: ["Bash(*)"] }), { code: "ISOLATION_UNSUPPORTED" });
    assert.throws(() => createCodexAdapter(config).startThread({ ...options, disallowedTools: ["Read"] }), { code: "ISOLATION_UNSUPPORTED" });
    const mandatory = createClaudeAdapter({ ...config, disallowedTools: ["Read"] });
    assert.deepEqual(mandatory.startThread({ ...options, disallowedTools: [] }).profile.tools, []);
    const policyDenied = createClaudeAdapter({ ...config, workerPolicy: { ...config.workerPolicy, disallowedTools: ["Read"] } });
    assert.deepEqual(policyDenied.startThread({ ...options, disallowedTools: [] }).profile.tools, []);
    const envelope = compileTask({ id: "proof" }, { prompt: "deny", disallowedTools: ["Read"] });
    assert.deepEqual(envelope.disallowedTools, ["Read"]);
    assert.notEqual(envelope.payloadDigest, compileTask({ id: "proof" }, { prompt: "deny" }).payloadDigest);
    console.log("FIXED R1: explicit denials, immutable profile/session compatibility and envelope digest PASS (no host sandbox)");
  }
  if (process.platform !== "linux") {
    console.log("NOT_TESTED: Linux invocation/filesystem checks; macOS sandbox execution prohibited by incident hold");
    return;
  }
  const prompt = JSON.stringify({ reads: [inside, outside], writes: [path.join(read, "new"), path.join(other, "new")] });
  const invoke = async (thread) => {
    const receipt = await thread.run(prompt);
    assert.equal(receipt.origin, "synthetic");
    return { receipt, observed: JSON.parse(receipt.finalResponse) };
  };
  const first = await invoke(allowed);
  assert.equal(first.observed.toolRead.ok, true);
  const denied = await invoke(reduced);
  assert.equal(denied.observed.toolRead.ok, baseline);
  assert.equal(option(denied.observed.argv, "--tools"), baseline ? "Read" : "");
  if (baseline) {
    const stale = await invoke(adapter.resumeThread(first.receipt.sessionId, { ...options, disallowedTools: ["Read"], resumeProfileDigest: first.receipt.metadata.profileDigest }));
    assert.equal(option(stale.observed.argv, "--resume"), first.receipt.sessionId);
    assert.equal(stale.observed.toolRead.ok, true);
    assert.equal(stale.receipt.metadata.profileDigest, first.receipt.metadata.profileDigest);
  }
  if (!baseline) {
    assert.equal(option(denied.observed.argv, "--allowedTools"), null);
    assert.ok(option(denied.observed.argv, "--disallowedTools").split(",").includes("Read"));
    const resumed = await invoke(adapter.resumeThread(denied.receipt.sessionId, { ...options, disallowedTools: ["Read"] }));
    assert.equal(resumed.observed.toolRead.ok, false);
    assert.equal(option(resumed.observed.argv, "--resume"), denied.receipt.sessionId);
    assert.equal(resumed.receipt.metadata.profileDigest, denied.receipt.metadata.profileDigest);
    const unrelated = await invoke(adapter.startThread({ ...options, disallowedTools: ["WebFetch"] }));
    assert.equal(unrelated.observed.toolRead.ok, true);
    assert.ok(option(unrelated.observed.argv, "--disallowedTools").includes("WebFetch"));
  }
  console.log(`${baseline ? "BEFORE" : "FIXED"} R1 Linux: actual shared-adapter start/resume invocation observed`);

  const combinations = [
    { label: "empty reads + write", readRoots: [], writeRoots: [read] },
    { label: "narrow child read + parent write", readRoots: [read], writeRoots: [root] },
    { label: "disjoint reads/writes", readRoots: [read], writeRoots: [other] }
  ];
  for (const combination of combinations) {
    const requested = { ...options, readOnly: false, allowedTools: [], readRoots: combination.readRoots, writeRoots: combination.writeRoots };
    if (baseline) {
      const { observed } = await invoke(adapter.startThread(requested));
      const leakedIndex = combination.writeRoots[0] === read ? 0 : 1;
      assert.equal(observed.reads[leakedIndex].ok, true);
      console.log(`BEFORE R2 Linux OS: ${combination.label}: excluded read succeeds via rw bind`);
    } else {
      assert.throws(() => adapter.startThread(requested), { code: "ISOLATION_UNSUPPORTED" });
      assert.throws(() => adapter.resumeThread(first.receipt.sessionId, requested), { code: "ISOLATION_UNSUPPORTED" });
      console.log(`FIXED R2 Linux: ${combination.label}: refused before start/resume spawn`);
    }
  }
  if (!baseline) {
    for (const supported of [
      { label: "overlapping rw", readRoots: [read], writeRoots: [read], reads: [true, false], writes: [true, false] },
      { label: "read-only", readRoots: [read], writeRoots: [], reads: [true, false], writes: [false, false] },
      { label: "empty reads/writes", readRoots: [], writeRoots: [], reads: [false, false], writes: [false, false] }
    ]) {
      const { observed } = await invoke(adapter.startThread({ ...options, readOnly: false, allowedTools: [], readRoots: supported.readRoots, writeRoots: supported.writeRoots }));
      assert.deepEqual(observed.reads.map((item) => item.ok), supported.reads);
      assert.deepEqual(observed.writes.map((item) => item.ok), supported.writes);
      console.log(`FIXED R2 Linux OS: ${supported.label}: ${JSON.stringify({ reads: observed.reads, writes: observed.writes })}`);
    }
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
