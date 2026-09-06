"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const { runJsonlProcess, DEFAULT_LIMITS } = require("../src/adapters/process");

const fixture = path.join(__dirname, "fixtures", "process-lifecycle.js");

const defaultLimits = Object.freeze({
  lineBytes: 256,
  stdoutBytes: 2048,
  events: 8,
  invalidLines: 4,
  stderrBytes: 128,
  killGraceMs: 100,
  cleanupMs: 1500
});

function runFixture(mode, options = {}) {
  return runJsonlProcess({
    command: process.execPath,
    args: [fixture, mode, ...(options.fixtureArgs || [])],
    cwd: __dirname,
    input: options.input,
    env: options.env || {},
    timeoutMs: options.timeoutMs || 2000,
    limits: options.limits || defaultLimits,
    onEvent: options.onEvent,
    onSpawn: options.onSpawn
  });
}

function assertPositiveLimitDefaults(counts) {
  for (const key of ["lineBytes", "stdoutBytes", "events", "invalidLines", "stderrBytes", "killGraceMs", "cleanupMs"]) {
    assert.equal(Number.isInteger(DEFAULT_LIMITS[key]) && DEFAULT_LIMITS[key] > 0, true, key);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGone(pid, deadlineMs = 2500) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

function readPid(file) {
  return Number(fs.readFileSync(file, "utf8"));
}

test("accepts bounded JSONL, explicit env, stdin, stderr, counts, and pid", async () => {
  process.env.PROCESS_LIFECYCLE_AMBIENT = "must-not-leak";
  try {
    const seen = [];
    const { promise } = runFixture("allowed", {
      input: "hello",
      env: { PROCESS_LIFECYCLE_SENTINEL: "explicit" },
      onEvent: (event) => seen.push(event.type)
    });

    const result = await promise;
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.cause, "EXIT");
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    assert.equal(Number.isInteger(result.pid) && result.pid > 0, true);
    assert.deepEqual(seen, ["env", "ambient", "input"]);
    assert.equal(result.events.find((event) => event.type === "env").value, "explicit");
    assert.equal(result.events.find((event) => event.type === "ambient").value, null);
    assert.equal(result.events.find((event) => event.type === "input").value, "hello");
    assert.match(result.stderr, /fixture-stderr/);
    assert.equal(result.invalidLines.length, 0);
    assertPositiveLimitDefaults(result.counts);
  } finally {
    delete process.env.PROCESS_LIFECYCLE_AMBIENT;
  }
});

test("rejects oversized unterminated stdout line with OUTPUT_LIMIT", async () => {
  const { promise } = runFixture("oversized-no-newline", { fixtureArgs: ["512"] });
  const result = await promise;
  assert.equal(result.cause, "OUTPUT_LIMIT");
  assert.equal(result.counts.stdoutBytes <= defaultLimits.stdoutBytes, true);
  assert.equal(result.counts.pendingBytes <= defaultLimits.lineBytes, true);
  assert.equal(result.events.length, 0);
});

test("rejects total stdout flood with bounded retention", async () => {
  const { promise } = runFixture("total-flood", {
    fixtureArgs: ["80"],
    limits: { ...defaultLimits, stdoutBytes: 512, events: 100 }
  });
  const result = await promise;
  assert.equal(result.cause, "OUTPUT_LIMIT");
  assert.equal(result.counts.stdoutBytes <= 512, true);
  assert.equal(result.events.length <= 100, true);
});

test("rejects event flood without retaining unbounded events", async () => {
  const { promise } = runFixture("events-flood", { fixtureArgs: ["50"] });
  const result = await promise;
  assert.equal(result.cause, "OUTPUT_LIMIT");
  assert.equal(result.counts.events, defaultLimits.events);
  assert.equal(result.events.length, defaultLimits.events);
});

test("rejects invalid line flood with bounded invalid retention", async () => {
  const { promise } = runFixture("invalid-lines", { fixtureArgs: ["20"] });
  const result = await promise;
  assert.equal(result.cause, "OUTPUT_LIMIT");
  assert.equal(result.counts.invalidLines, defaultLimits.invalidLines);
  assert.equal(result.invalidLines.length, defaultLimits.invalidLines);
});

test("bounds retained stderr bytes", async () => {
  const { promise } = runFixture("stderr-flood", {
    fixtureArgs: ["2048"],
    limits: { ...defaultLimits, stderrBytes: 64 }
  });
  const result = await promise;
  assert.equal(result.cause, "OUTPUT_LIMIT");
  assert.ok(Buffer.byteLength(result.stderr) <= 64);
  assert.ok(result.counts.stderrBytes <= 64);
});

test("pre-event cancel resolves CANCELLED and repeat cancel is idempotent", async () => {
  const { promise, cancel } = runFixture("slow");
  assert.equal(cancel(), true);
  assert.equal(cancel(), false);
  const result = await promise;
  assert.equal(result.cause, "CANCELLED");
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
});

test("timeout wins timeout/cancel race once timeout is already recorded", async () => {
  let cancel;
  const { promise, cancel: cancelRun } = runFixture("slow", { timeoutMs: 50 });
  cancel = cancelRun;
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(cancel(), false);
  const result = await promise;
  assert.equal(result.cause, "TIMEOUT");
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
});

test("ENOENT spawn resolves SPAWN_ERROR with bounded result shape", async () => {
  const { promise } = runJsonlProcess({
    command: path.join(os.tmpdir(), `missing-${Date.now()}`),
    args: [],
    cwd: __dirname,
    env: {},
    timeoutMs: 1000,
    limits: defaultLimits
  });
  const result = await promise;
  assert.equal(result.cause, "SPAWN_ERROR");
  assert.equal(result.code, null);
  assert.equal(result.signal, null);
  assert.equal(result.pid, null);
});

test("TERM-ignoring child and grandchild in owned group are gone by cleanup deadline", async () => {
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "process-lifecycle-"));
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  unrelated.unref();

  const knownPids = [];
  const { promise, cancel } = runFixture("term-tree", {
    env: { PROCESS_LIFECYCLE_PID_DIR: pidDir },
    limits: { ...defaultLimits, killGraceMs: 100, cleanupMs: 2500 }
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const parentPid = readPid(path.join(pidDir, "parent.pid"));
    const childPid = readPid(path.join(pidDir, "child.pid"));
    const grandchildPid = readPid(path.join(pidDir, "grandchild.pid"));
    knownPids.push(parentPid, childPid, grandchildPid);
    assert.equal(cancel(), true);

    const result = await promise;
    assert.equal(result.cause, "CANCELLED");
    assert.equal(await waitForGone(parentPid), true, "parent still alive");
    assert.equal(await waitForGone(childPid), true, "child still alive");
    assert.equal(await waitForGone(grandchildPid), true, "grandchild still alive");
    assert.equal(isAlive(unrelated.pid), true, "unrelated process was killed");
  } finally {
    for (const pid of knownPids) {
      if (isAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    try { process.kill(-unrelated.pid, "SIGKILL"); } catch {}
  }
});
