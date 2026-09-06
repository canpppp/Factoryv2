"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createChannelRegistry } = require("../src/channels");
const { createClaudeAdapter } = require("../src/adapters/claude");
const { createCodexAdapter } = require("../src/adapters/codex");
const { fixtureProfile } = require("./fixtures/isolated-profile");
const journal = require("../src/journal");
const H = require("./helpers");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(engine = "claude", extra = {}) {
  const business = H.tmp("factory-m02-business-");
  const outside = H.tmp("factory-m02-outside-");
  const root = H.tmp("factory-m02-journal-");
  fs.writeFileSync(path.join(business, "allowed"), "approved input");
  fs.writeFileSync(path.join(outside, "secret"), "SYNTHETIC-DENIED-CONTENT");
  fs.symlinkSync(outside, path.join(business, "escape"));
  const config = fixtureProfile(path.join(__dirname, "fixtures/isolation-cli.js"), { readRoots: [business], writeRoots: [business], ...extra });
  const definitionsPath = path.join(root, "channels.json");
  const definition = { id: "proof", cwd: business, engine, allowedTools: ["Read", "Write"], writeAuthority: "workspace", readWriteProfile: "workspace-write", capsule: "Synthetic isolation fixture", workerPolicy: { ...config.workerPolicy, executable: config.command } };
  fs.writeFileSync(definitionsPath, JSON.stringify([definition]));
  const registry = () => createChannelRegistry({ root, definitionsPath });
  const current = registry(); current.ensureDefaults();
  const request = { mode: "inspect", allowed: path.join(business, "allowed"), outside: path.join(outside, "secret"), symlink: path.join(business, "escape/secret"), write: path.join(business, "write"), outsideWrite: path.join(outside, "write"), escapeWrite: path.join(business, "escape/write") };
  return { root, business, outside, definition, definitionsPath, current, registry, request, config };
}
async function submit(f, request = f.request, options = {}) {
  const job = f.current.send("proof", JSON.stringify(request), { timeoutMs: 1000, requestedTools: ["Read"], ...options });
  let run = await f.current.runNext();
  if (run.retry) run = await f.current.runNext();
  return { job, run, events: journal.load(f.root).events };
}

async function main() {
  const f = setup();
  const sentinels = { FACTORY_M0_SENTINEL: "synthetic-secret", ANTHROPIC_API_KEY: "synthetic-api-key", OPENAI_API_KEY: "synthetic-api-key", NODE_OPTIONS: "--no-warnings" };
  const original = Object.fromEntries(Object.keys(sentinels).map((key) => [key, process.env[key]]));
  Object.assign(process.env, sentinels);
  try {
    const first = await submit(f);
    assert.equal(first.run.result.ok, true, JSON.stringify(first.run));
    const observed = JSON.parse(first.run.result.summary);
    assert.equal(observed.read.value, "approved input");
    for (const key of ["outside", "symlink", "write", "outsideWrite", "escapeWrite"]) assert.equal(observed[key].ok, false, key);
    assert.deepEqual(observed.ambient, []); assert.equal(observed.path, "/usr/bin:/bin");
    assert.equal(observed.tools, "Read"); assert.equal(observed.safe, true); assert.notEqual(observed.shell, 0);
    assert.ok(!observed.home.startsWith(f.business));
    const digest = first.run.result.receipt.metadata.profileDigest;
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(first.run.result.receipt.metadata.synthetic, true);
    assert.equal(first.events.find((e) => e.type === "channel.worker.input").evidenceOrigin, "synthetic");
    assert.ok(!JSON.stringify(first.events).includes("synthetic-secret"));
    const id = f.current.status("proof").sessionId;
    f.current = f.registry();
    const resumed = await submit(f);
    assert.equal(resumed.run.result.ok, true); assert.equal(f.current.status("proof").sessionId, id);
    assert.equal(resumed.run.result.receipt.metadata.profileDigest, digest);
    const writable = await submit(f, f.request, { readWriteBoundary: "workspace-write", requestedTools: ["Read", "Write"] });
    assert.equal(writable.run.result.ok, true);
    assert.equal(JSON.parse(writable.run.result.summary).write.ok, true);
    assert.notEqual(f.current.status("proof").sessionId, id, "changed policy must not reuse session");
    assert.notEqual(writable.run.result.receipt.metadata.profileDigest, digest);
    assert.throws(() => f.current.send("proof", "denied", { requestedTools: ["Bash"] }), { code: "TOOL_POLICY_DENIED" });
    const deniedRoot = await submit(f, f.request, { readRoots: [f.outside] });
    assert.equal(deniedRoot.run.result.code, "POLICY_DENIED");
    const deniedBudget = await submit(f, f.request, { outputLimits: { stdoutBytes: 999999999 } });
    assert.equal(deniedBudget.run.result.code, "POLICY_DENIED");
    assert.equal(fs.existsSync(f.request.outsideWrite), false);
  } finally { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }

  for (const [mode, outputLimits] of [["line", { lineBytes: 128 }], ["events", { events: 2 }], ["events", { stdoutBytes: 128 }], ["invalid", { invalidLines: 2 }], ["stderr", { stderrBytes: 128 }]]) {
    const f = setup();
    const result = await submit(f, { mode }, { outputLimits });
    assert.equal(result.run.result.code, "OUTPUT_LIMIT", mode);
    assert.ok(!result.events.some((event) => event.type === "channel.job.finished"));
    assert.equal(result.events.findLast((event) => event.type === "worker.attempt.finished").receipt.metadata.terminationCause, "OUTPUT_LIMIT");
  }
  for (const action of ["cancel", "pause"]) {
    const f = setup("codex");
    f.current.send("proof", JSON.stringify({ mode: "slow" }), { timeoutMs: 1000 });
    const pending = f.current.runNext();
    await sleep(60); assert.equal(f.current.status("proof").sessionId, null);
    f.current[action]("proof");
    const result = await pending;
    assert.equal(action === "cancel" ? result.cancelled : result.paused, true);
    const attempt = journal.load(f.root).events.findLast((event) => event.type === "worker.attempt.finished");
    assert.equal(attempt.code, "CANCELLED");
    assert.equal(attempt.receipt.metadata.externalEffects, "UNKNOWN");
  }
  const tree = setup("codex");
  tree.current.send("proof", JSON.stringify({ mode: "tree", dir: tree.business }), { timeoutMs: 2000, readWriteBoundary: "workspace-write" });
  const treeRun = tree.current.runNext();
  const deadline = Date.now() + 1500;
  while (!fs.existsSync(path.join(tree.business, "grandchild.pid")) && Date.now() < deadline) await sleep(20);
  assert.ok(fs.existsSync(path.join(tree.business, "grandchild.pid")), "tree fixture did not start");
  const pids = ["parent", "child", "grandchild"].map((name) => Number(fs.readFileSync(path.join(tree.business, `${name}.pid`), "utf8")));
  tree.current.cancel("proof");
  await treeRun;
  const treeAttempt = journal.load(tree.root).events.findLast((event) => event.type === "worker.attempt.finished");
  assert.equal(treeAttempt.code, "CANCELLED");
  if (process.platform === "darwin") for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  // Linux fixture PIDs are namespace-local; the owned bwrap PID is the host identity.
  assert.throws(() => process.kill(treeAttempt.receipt.metadata.pid, 0), { code: "ESRCH" });

  const narrowed = setup();
  const contextBlocked = await submit(narrowed, narrowed.request, { readRoots: [], requiredRefs: ["file:allowed"] });
  assert.equal(contextBlocked.run.result.code, "CONTEXT_POLICY_DENIED");
  assert.throws(() => narrowed.current.send("proof", "override", { env: {} }), { code: "POLICY_DENIED" });
  const limited = setup();
  const subdir = path.join(limited.business, "permitted"); fs.mkdirSync(subdir);
  limited.definition.workerPolicy.readRoots = [subdir];
  fs.writeFileSync(limited.definitionsPath, JSON.stringify([limited.definition]));
  limited.current.ensureDefaults();
  const widerPriming = await submit(limited, limited.request, { readRoots: [limited.business], requiredRefs: ["file:allowed"] });
  assert.equal(widerPriming.run.result.code, "POLICY_DENIED");
  assert.ok(!widerPriming.events.some((event) => event.type === "channel.context.resolved"));
  const unsupported = setup();
  delete unsupported.definition.workerPolicy;
  fs.writeFileSync(unsupported.definitionsPath, JSON.stringify([unsupported.definition]));
  unsupported.current.ensureDefaults();
  const blocked = await submit(unsupported);
  assert.equal(blocked.run.result.code, "ISOLATION_UNSUPPORTED");

  const { config, business } = setup();
  const adapter = createClaudeAdapter(config);
  const options = { cwd: business, allowedTools: ["Read"], readOnly: true };
  const t = adapter.startThread(options);
  options.allowedTools.push("Write"); config.workerPolicy.tools.push("UNAPPROVED");
  assert.deepEqual(t.profile.tools, ["Read"]); assert.ok(Object.isFrozen(t.profile.tools));
  assert.throws(() => adapter.resumeThread("old", { ...options, allowedTools: ["Read"], resumeProfileDigest: "old-policy" }), { code: "SESSION_POLICY_CHANGED" });
  const real = { ...config, workerPolicy: { ...config.workerPolicy, protocolFixtureSha256: null } };
  assert.throws(() => createCodexAdapter(real).startThread({ cwd: business }), { code: "ISOLATION_UNSUPPORTED" });
  console.log("M0.2 channel -> adapter -> sandbox: allowed/denied roots, symlink escapes, tools, env, resume, limits, pre-ID cancel/pause PASS (synthetic)");
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
