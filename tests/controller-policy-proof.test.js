"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createController } = require("../src/controller");
const { createDaemon } = require("../src/daemon");
const { createAdapter } = require("../src/adapters");
const { loadRolePolicies } = require("../src/controller-policy");
const journal = require("../src/journal");
const H = require("./helpers");
const { fixtureProfile } = require("./fixtures/isolated-profile");

const copy = (value) => JSON.parse(JSON.stringify(value));
const current = (f) => journal.load(f.root).missions.get(f.id);
const state = (f, to) => journal.append(f.root, { type: "mission.state", missionId: f.id, to });
const option = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
function fixture() {
  const root = H.tmp("factory-controller-policy-");
  const repo = H.makeBugRepo();
  const outside = path.join(repo, "README.md");
  const base = path.join(root, "private"); fs.mkdirSync(base, { mode: 0o700 });
  const peerState = path.join(base, "sentinel"); fs.writeFileSync(peerState, "not business data");
  fs.writeFileSync(path.join(repo, "proof-request.json"), JSON.stringify({ outside, peerState }));
  H.git(repo, ["add", "."]); H.git(repo, ["commit", "-qm", "seed controller probe"]);
  const worktrees = path.join(root, "worktrees"); fs.mkdirSync(worktrees);
  const config = fixtureProfile(path.join(__dirname, "fixtures/controller-cli.js"));
  const rolePolicies = Object.fromEntries(["worker", "reviewer"].map((role) => [role, {
    ...config, engine: "claude", model: "fixture", maxTurns: role === "worker" ? 12 : 6,
    allowedTools: role === "worker" ? ["Read", "Write"] : ["Read"], disallowedTools: ["WebFetch"],
    workerPolicy: { ...config.workerPolicy, stateRoot: base, readRoots: [worktrees], writeRoots: role === "worker" ? [worktrees] : [], timeoutMs: 3000 }
  }]));
  const f = { root, repo, rolePolicies, id: "mission-controller", base };
  const controller = createController({ root, rolePolicies });
  controller.enqueueGoal({ goal: "Fixture controller proof", repo, missionOverrides: { id: f.id, title: "fixture only", verifyCommands: [], maxRepairRounds: 1 } });
  f.controller = controller;
  return f;
}
function traces(f) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === "trace.jsonl") found.push(...fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse));
    }
  };
  walk(f.base);
  return found;
}
async function prepare(f) { await f.controller.step(); }
async function refuse(mutator, expected) {
  const f = fixture(); await prepare(f);
  const policies = copy(f.rolePolicies);
  mutator(f, policies);
  let starts = 0;
  const controller = createController({ root: f.root, rolePolicies: policies, adapterFactory: () => { starts++; throw new Error("must not construct adapter"); } });
  await controller.step();
  assert.equal(current(f).state, "blocked");
  assert.match(current(f).blocker, new RegExp(expected));
  assert.equal(starts, 0);
  assert.equal(traces(f).length, 0);
  assert.ok(!journal.load(f.root).events.some((event) => event.type === "repair.queued" || event.type === "review.finished"));
}
async function main() {
  const missing = fixture(); await prepare(missing);
  let constructions = 0;
  const noPolicy = createController({ root: missing.root, adapterFactory: () => { constructions++; } });
  const missingResult = await noPolicy.step();
  assert.equal(missingResult.code, "ISOLATION_UNSUPPORTED"); assert.equal(constructions, 0);
  for (const injection of [{ workerPolicy: {} }, { rolePolicies: {} }, { workerThreadId: "peer" }, { worktree: "/tmp" }, { id: "../escape" }, { missions: [{ roleSessions: {} }] }]) {
    assert.throws(() => noPolicy.enqueueGoal({ goal: "injection", repo: missing.repo, missionOverrides: injection }), { code: "POLICY_DENIED" });
  }
  await refuse((f, policies) => { delete policies.reviewer; }, "ISOLATION_UNSUPPORTED");
  await refuse((f, policies) => { policies.reviewer.workerPolicy.writeRoots = policies.worker.workerPolicy.writeRoots; }, "POLICY_DENIED");
  await refuse((f, policies) => { policies.reviewer.workerPolicy.runtimeReadRoots = [f.base]; }, "POLICY_DENIED");
  await refuse((f, policies) => { delete policies.worker.workerPolicy.protocolFixtureSha256; policies.worker.workerPolicy.auth = { mode: "subscription-token", tokenEnv: "FACTORYV2_UNUSED_TOKEN" }; }, "ISOLATION_UNSUPPORTED");
  for (const request of [{ allowedTools: ["Bash"] }, { readRoots: [missing.repo] }, { writeRoots: [missing.repo] }, { limits: { stdoutBytes: 999999999 } }, { maxTurns: 99 }, { env: {} }]) {
    const f = fixture();
    const created = journal.load(f.root).events.find((event) => event.type === "goal.enqueued");
    // Seed the requested narrowing through the same goal input used by the architect.
    created.goal.missionOverrides.roleRequests = { worker: request };
    journal.append(f.root, created);
    await prepare(f);
    let calls = 0;
    await createController({ root: f.root, rolePolicies: f.rolePolicies, adapterFactory: () => { calls++; } }).step();
    assert.equal(current(f).state, "blocked"); assert.equal(calls, 0);
  }
  const frozen = loadRolePolicies({ rolePolicies: missing.rolePolicies });
  assert.ok(Object.isFrozen(frozen.worker.workerPolicy));
  const writableConfig = path.join(missing.root, "worktrees", "operator.json"); fs.writeFileSync(writableConfig, JSON.stringify(missing.rolePolicies));
  assert.throws(() => loadRolePolicies({ rolePoliciesPath: writableConfig }), { code: "POLICY_DENIED" });
  console.log("M0.2-C pre-spawn: trusted grants, missing/unsupported profiles, reviewer writes and mission widening refused PASS");

  const failed = fixture(); await prepare(failed);
  const injected = createController({ root: failed.root, rolePolicies: failed.rolePolicies, adapterFactory: (config) => {
    const real = createAdapter(config);
    return { startThread: (options) => {
      const admitted = real.startThread(options); // Compilation only: no host sandbox launch.
      return { profile: admitted.profile, run: async () => { throw Object.assign(new Error("cleanup secret-like diagnostic must not be persisted"), { code: "CLEANUP_FAILED" }); } };
    } };
  } });
  await injected.step();
  assert.equal(current(failed).roleSessions.worker.sessionId, null);
  assert.equal(current(failed).roleSessions.worker.status, "uncertain");
  state(failed, "repair");
  let retried = 0;
  await createController({ root: failed.root, rolePolicies: failed.rolePolicies, adapterFactory: () => { retried++; } }).step();
  assert.equal(retried, 0); assert.match(current(failed).blocker, /CLEANUP_FAILED/);
  assert.ok(journal.load(failed.root).events.some((event) => event.type === "mission.attempt.finished" && event.code === "CLEANUP_FAILED" && event.receipt.metadata.externalEffects === "UNKNOWN"));
  assert.ok(!fs.readFileSync(journal.paths(failed.root).journal, "utf8").includes("secret-like"));
  console.log("M0.2-C cleanup failure before session ID: UNKNOWN, durable retry block, redacted typed receipt PASS (fault injection)");
  const unproven = fixture(); await prepare(unproven);
  await createController({ root: unproven.root, rolePolicies: unproven.rolePolicies, adapterFactory: (config) => ({ startThread: (options) => {
    const admitted = createAdapter(config).startThread(options);
    return { profile: admitted.profile, run: async () => { throw Object.assign(new Error("timeout without settlement evidence"), { code: "TIMEOUT", details: { receipt: { metadata: { profileDigest: admitted.profile.digest, terminationCause: "TIMEOUT", externalEffects: "UNKNOWN" } } } }); } };
  } }) }).step();
  assert.equal(current(unproven).state, "blocked"); assert.equal(current(unproven).roleSessions.worker.status, "uncertain");
  assert.ok(!journal.load(unproven.root).events.some((event) => event.type === "worker.replaced"));

  const cli = path.resolve(__dirname, "../bin/factoryv2.js");
  const absent = fixture(); await prepare(absent);
  const missingCli = spawnSync(process.execPath, [cli, "run", "--local-test", "--root", absent.root, "--max-steps", "1"], { encoding: "utf8" });
  assert.equal(missingCli.status, 1); assert.match(missingCli.stdout, /ISOLATION_UNSUPPORTED/); assert.match(current(absent).blocker, /ISOLATION_UNSUPPORTED/); assert.equal(traces(absent).length, 0);
  const daemonAbsent = fixture(); await prepare(daemonAbsent);
  let daemonCalls = 0;
  const definitions = H.makeChannelDefinitions();
  await createDaemon({ root: daemonAbsent.root, adapterFactory: () => { daemonCalls++; }, notifier: () => {}, channelDefinitionsPath: definitions.definitionsPath }).runOnce();
  assert.equal(daemonCalls, 0); assert.match(current(daemonAbsent).blocker, /ISOLATION_UNSUPPORTED/);
  if (process.platform !== "linux") {
    console.log("NOT_TESTED: actual controller/daemon/CLI sandbox consumers require disposable Linux CI; host incident hold");
    return;
  }

  const f = fixture(); await prepare(f);
  await f.controller.step(); // worker
  let m = current(f), first = m.roleSessions.worker;
  assert.equal(m.state, "verifying"); assert.equal(first.status, "settled");
  assert.equal(first.sessionId, m.workerThreadId); assert.ok(first.profileDigest);
  const workerHome = traces(f)[0].home;
  const requestPath = path.join(m.worktree, "proof-request.json");
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  fs.writeFileSync(requestPath, JSON.stringify({ ...request, peerState: path.join(workerHome, "trace.jsonl") }));
  await f.controller.step(); await f.controller.step(); // verifier, independent reviewer
  m = current(f);
  const reviewer = m.roleSessions.reviewer;
  assert.equal(m.state, "repair"); assert.notEqual(reviewer.sessionId, first.sessionId); assert.notEqual(reviewer.profileDigest, first.profileDigest);
  const observed = traces(f);
  const workerObs = observed.find((item) => item.role === "worker"), reviewerObs = observed.find((item) => item.role === "reviewer");
  assert.equal(workerObs.write.ok, true); assert.equal(reviewerObs.write.ok, false);
  for (const item of observed) { assert.equal(item.read.ok, true); assert.equal(item.outside.ok, false); assert.equal(item.peerState.ok, false); }
  assert.notEqual(workerObs.home, reviewerObs.home);
  assert.equal(option(workerObs.args, "--tools"), "Read,Write"); assert.equal(option(reviewerObs.args, "--tools"), "Read");
  assert.ok(option(reviewerObs.args, "--disallowedTools").includes("Write"));
  assert.ok(option(workerObs.args, "--disallowedTools").includes("WebFetch"));
  console.log(`M0.2-C Linux controller OS access: ${JSON.stringify(observed)}`);

  const restarted = createController({ root: f.root, rolePolicies: f.rolePolicies });
  await restarted.step();
  m = current(f); assert.equal(m.workerThreadId, first.sessionId); assert.equal(m.roleSessions.worker.profileDigest, first.profileDigest);
  assert.ok(traces(f).some((item) => item.role === "worker" && option(item.args, "--resume") === first.sessionId));
  state(f, "reviewing"); await restarted.step();
  assert.equal(current(f).reviewerThreadId, reviewer.sessionId);
  assert.ok(traces(f).some((item) => item.role === "reviewer" && option(item.args, "--resume") === reviewer.sessionId));

  state(f, "repair");
  const changed = copy(f.rolePolicies); changed.worker.disallowedTools.push("Read");
  await createController({ root: f.root, rolePolicies: changed }).step();
  m = current(f); assert.notEqual(m.workerThreadId, first.sessionId); assert.notEqual(m.roleSessions.worker.profileDigest, first.profileDigest);
  assert.equal(m.reviewerThreadId, reviewer.sessionId);
  const denied = traces(f).find((item) => item.sessionId === m.workerThreadId);
  assert.equal(option(denied.args, "--tools"), "Write"); assert.equal(option(denied.args, "--resume"), null);
  console.log("M0.2-C Linux fresh-instance worker/reviewer compatible resume and affected-role-only policy reset PASS");

  const legacy = fixture(); await prepare(legacy);
  journal.append(legacy.root, { type: "mission.field", missionId: legacy.id, field: "workerThreadId", value: "legacy-session" });
  journal.append(legacy.root, { type: "agent.receipt", missionId: legacy.id, role: "worker", receipt: { ok: true, sessionId: "legacy-session", metadata: { terminationCause: "EXIT" } } });
  await legacy.controller.step();
  assert.equal(current(legacy).state, "verifying"); assert.notEqual(current(legacy).workerThreadId, "legacy-session");
  assert.equal(option(traces(legacy)[0].args, "--resume"), null);
  for (const mode of ["legacy", "legacy-failed", "running", "uncertain", "peer-identity"]) {
    const blocked = fixture(); await prepare(blocked);
    if (mode.startsWith("legacy")) {
      journal.append(blocked.root, { type: "mission.field", missionId: blocked.id, field: "workerThreadId", value: "unknown-session" });
      if (mode === "legacy-failed") journal.append(blocked.root, { type: "agent.receipt", missionId: blocked.id, role: "worker", receipt: { ok: false, sessionId: "unknown-session", metadata: { terminationCause: "EXIT" } } });
    }
    else {
      const record = { ...first, missionId: blocked.id, status: mode === "peer-identity" ? "settled" : mode };
      journal.append(blocked.root, { type: "mission.role.session", missionId: blocked.id, role: "worker", record });
      if (mode === "peer-identity") journal.append(blocked.root, { type: "mission.role.session", missionId: blocked.id, role: "reviewer", record: { ...record, role: "reviewer" } });
    }
    await blocked.controller.step();
    assert.equal(current(blocked).state, "blocked"); assert.equal(traces(blocked).length, 0);
  }
  console.log("M0.2-C Linux legacy settled reset / legacy unknown and unresolved / cross-role identity refusal PASS");

  const configuredCli = fixture(); await prepare(configuredCli);
  const configPath = path.join(configuredCli.root, "operator-role-policies.json");
  fs.writeFileSync(configPath, JSON.stringify(configuredCli.rolePolicies));
  const launched = spawnSync(process.execPath, [cli, "run", "--local-test", "--root", configuredCli.root, "--role-policies", configPath, "--max-steps", "3"], { encoding: "utf8", timeout: 20000 });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(traces(configuredCli).map((item) => item.role).sort(), ["reviewer", "worker"]);
  assert.equal(current(configuredCli).state, "repair");

  const daemonFixture = fixture(); await prepare(daemonFixture);
  const daemonPath = path.join(daemonFixture.root, "operator-role-policies.json"); fs.writeFileSync(daemonPath, JSON.stringify(daemonFixture.rolePolicies));
  await createDaemon({ root: daemonFixture.root, rolePoliciesPath: daemonPath, notifier: () => {}, channelDefinitionsPath: definitions.definitionsPath }).runOnce();
  assert.ok(traces(daemonFixture).some((item) => item.role === "reviewer"));
  assert.equal(current(daemonFixture).state, "blocked"); // reviewer budget, never integrate
  const daemonCli = fixture(); await prepare(daemonCli);
  const daemonCliPath = path.join(daemonCli.root, "operator-role-policies.json"); fs.writeFileSync(daemonCliPath, JSON.stringify(daemonCli.rolePolicies));
  const once = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/factoryd.js"), "--once", "--local-test", "--root", daemonCli.root, "--role-policies", daemonCliPath], { encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, HOME: daemonCli.root } });
  assert.equal(once.status, 0, once.stderr); assert.ok(traces(daemonCli).some((item) => item.role === "reviewer"));
  for (const target of [f, configuredCli, daemonFixture, daemonCli]) assert.ok(!journal.load(target.root).events.some((event) => ["integration.finished", "candidate.verified", "release.evaluated"].includes(event.type)));
  console.log("M0.2-C Linux CLI and daemon operator configuration -> actual worker/reviewer consumers PASS; no integration/candidate/release");
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
