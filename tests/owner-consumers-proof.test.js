"use strict";

if (process.platform !== "linux") {
  console.log("NOT_TESTED: OWNER Linux CLI/daemon/process consumers; no host sandbox operation");
} else {
  main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}

async function main() {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { fork } = require("node:child_process");
  const { randomUUID } = require("node:crypto");
  const H = require("./helpers");
  const journal = require("../src/journal");
  const { createController } = require("../src/controller");
  const { load } = require("../src/mission-requests");
  const { read } = require("../src/execution-owner");
  const { call, exchange } = require("../src/owner-client");
  const { fixtureProfile } = require("./fixtures/isolated-profile");
  const { identity, same, signal } = require("./fixtures/linux-ownership-host");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    do { const value = await fn(); if (value) return value; await sleep(10); } while (Date.now() < end);
    throw new Error("OWNER bounded barrier timed out");
  }
  const evidence = [];
  for (const stage of ["client-loss", "before-ready", "admitted", "before-identity", "before-release"]) {
    const root = H.tmp("fo-"), control = H.tmp("fc-"), token = randomUUID(), repo = H.makeBugRepo();
    const expiry = Date.now() + 22000, report = path.join(control, "watchdog.json");
    const tracked = [];
    function start(file, args) {
      const child = fork(path.join(__dirname, "fixtures", file), args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const output = [], messages = [];
      child.stdout.on("data", (c) => output.push(c.toString()));
      child.stderr.on("data", (c) => output.push(c.toString()));
      child.on("message", (m) => messages.push(m));
      const proc = { child, output, messages, saved: identity(child.pid), closed: new Promise((resolve) => child.on("close", (code, sig) => resolve({ code, signal: sig }))) };
      tracked.push(proc); return proc;
    }
    const watchdog = start("linux-ownership-watchdog.js", [token, String(expiry - 1000), report]);
    await until(() => watchdog.messages.length);
    let error, outcome, captured;
    try {
      journal.ensure(root);
      const provider = fixtureProfile(path.join(__dirname, "fixtures/owner-worker.js"));
      const worktrees = path.join(root, "worktrees");
      const rolePolicies = Object.fromEntries(["worker", "reviewer"].map((role) => [role, {
        ...provider, engine: "claude", model: "fixture", allowedTools: role === "worker" ? ["Read", "Write"] : ["Read"],
        workerPolicy: { ...provider.workerPolicy, readRoots: [worktrees], writeRoots: role === "worker" ? [worktrees] : [], timeoutMs: 7000, limits: { killGraceMs: 100, cleanupMs: 2000 } }
      }]));
      const policies = path.join(root, "operator.json"); fs.writeFileSync(policies, JSON.stringify(rolePolicies), { mode: 0o600 });
      const controller = createController({ root, rolePolicies });
      controller.enqueueGoal({ goal: "Synthetic daemon mission ownership", repo, missionOverrides: { id: "owned", verifyCommands: [], maxRepairRounds: 0 } });
      await controller.step();
      const configPath = path.join(control, "config.json");
      const config = { root, control, expiry, stage };
      fs.writeFileSync(configPath, JSON.stringify(config));
      const daemonArgs = ["--root", root, "--role-policies", policies, "--poll-ms", "10"];
      const daemon = () => start("owner-entry.js", [configPath, token, "daemon", ...daemonArgs]);
      const client = (...args) => start("owner-entry.js", [configPath, token, "client", ...args, "--root", root]);
      const runArgs = ["run", "--mission", "owned", "--request-id", "one", "--max-steps", "1"];
      const ready = () => until(async () => {
        const record = read(root);
        if (!record?.ready) return false;
        try { return (await exchange(record.endpoint, "GET")).ok; } catch { return false; }
      });
      const missing = client(...runArgs);
      assert.equal((await missing.closed).code, 1); assert.match(missing.output.join(""), /OWNER_UNAVAILABLE/);
      let owner = daemon();
      if (stage === "client-loss") {
        const contender = daemon();
        await ready();
        const winner = read(root).process.pid;
        const loser = winner === owner.child.pid ? contender : owner;
        owner = winner === owner.child.pid ? owner : contender;
        assert.equal((await loser.closed).code, 1);
        assert.match(loser.output.join(""), /OWNER_UNAVAILABLE|OWNER_UNKNOWN/);
      }
      if (stage === "before-ready") {
        await until(() => fs.existsSync(path.join(control, stage)));
        const waiting = client(...runArgs);
        assert.equal((await waiting.closed).code, 1); assert.match(waiting.output.join(""), /OWNER_NOT_READY/);
        assert.equal(load(root).requests.size, 0);
      } else {
        await ready();
        const duplicateOwner = daemon();
        assert.equal((await duplicateOwner.closed).code, 1);
        assert.match(duplicateOwner.output.join(""), /OWNER_UNAVAILABLE|OWNER_UNKNOWN/);
        await ready();
        const submitted = client(...runArgs, "--wait");
        if (stage === "admitted") await until(() => fs.existsSync(path.join(control, stage)));
        else if (stage.startsWith("before-")) {
          await until(() => fs.existsSync(path.join(control, stage)));
          captured = JSON.parse(fs.readFileSync(path.join(control, stage)));
          assert.equal(captured.receipt.state, stage === "before-release" ? "ACTIVE" : "PENDING");
        } else {
          const mission = await until(() => {
            const m = journal.load(root).missions.get("owned");
            return m.worktree && fs.existsSync(path.join(m.worktree, "worker-entered")) && m;
          });
          assert.equal(signal(submitted.saved, "SIGKILL"), true); await submitted.closed;
          assert.ok(same(owner.saved));
          const repeat = await call(root, "mission.run", { requestId: "one", missionId: "owned", maxSteps: 1 });
          assert.equal(repeat.status, "started");
          await assert.rejects(call(root, "mission.run", { requestId: "one", missionId: "owned", maxSteps: 2 }), { code: "REQUEST_CONFLICT" });
          await assert.rejects(call(root, "mission.run", { requestId: "other", missionId: "owned", rolePolicies }), { code: "REQUEST_INVALID" });
          const wrong = H.tmp("fw-"); journal.ensure(wrong);
          fs.copyFileSync(path.join(root, "daemon/owner.json"), path.join(wrong, "daemon/owner.json"));
          await assert.rejects(call(wrong, "mission.result", { requestId: "one" }), { code: "OWNER_WRONG_ROOT" });
          fs.writeFileSync(path.join(mission.worktree, "worker-release"), "");
          await until(() => load(root).requests.get("one")?.status === "finished");
          const reconnect = client("result", "--request-id", "one");
          assert.equal((await reconnect.closed).code, 0, reconnect.output.join(""));
          outcome = JSON.parse(reconnect.output.join(""));
          assert.deepEqual(outcome, load(root).requests.get("one"));
          assert.equal(outcome.outcome.execution.ok, true, JSON.stringify(outcome));
          assert.equal(outcome.outcome.objectiveCompleted, false);
          assert.equal(outcome.outcome.missionState, "verifying");
          assert.equal(fs.readFileSync(path.join(mission.worktree, "worker-entered"), "utf8"), "invocation\n");
          assert.ok(outcome.outcome.roleSessions.worker.attemptId);
          assert.equal(outcome.outcome.roleSessions.worker.status, "settled");
        }
        if (stage !== "client-loss") {
          const m = journal.load(root).missions.get("owned");
          assert.equal(Boolean(m.worktree && fs.existsSync(path.join(m.worktree, "worker-entered"))), false, "worker cannot run before barrier");
          signal(submitted.saved, "SIGKILL"); await submitted.closed;
        }
      }
      if (stage !== "client-loss") {
        signal(owner.saved, "SIGKILL"); await owner.closed;
        fs.writeFileSync(configPath, JSON.stringify({ ...config, stage: "restart" }));
        if (stage === "before-ready") {
          const ownerFile = path.join(root, "daemon/owner.json");
          const savedRecord = fs.readFileSync(ownerFile);
          fs.unlinkSync(ownerFile);
          const ambiguous = daemon();
          assert.equal((await ambiguous.closed).code, 1);
          assert.match(ambiguous.output.join(""), /OWNER_UNKNOWN/);
          assert.ok(fs.lstatSync(path.join(root, "daemon/channel-api.sock")).isSocket());
          fs.writeFileSync(ownerFile, savedRecord, { mode: 0o600 });
        }
        // Recovery uses the old owner generation and exact socket identity, not PID signalling.
        const replacement = daemon(); await ready();
        if (stage === "before-ready") {
          assert.equal(load(root).requests.size, 0);
        } else if (stage === "admitted") {
          const m = await until(() => {
            const value = journal.load(root).missions.get("owned");
            return value.worktree && fs.existsSync(path.join(value.worktree, "worker-entered")) && value;
          });
          fs.writeFileSync(path.join(m.worktree, "worker-release"), "");
          await until(() => load(root).requests.get("one").status === "finished");
          assert.equal(fs.readFileSync(path.join(m.worktree, "worker-entered"), "utf8"), "invocation\n");
        } else {
          assert.equal(load(root).requests.get("one").status, "blocked");
          await assert.rejects(call(root, "mission.run", { requestId: "replay", missionId: "owned" }), { code: "MISSION_REQUEST_BLOCKED" });
          assert.equal(journal.load(root).events.filter((e) => e.type === "owner.request.started").length, 1);
        }
        signal(replacement.saved, "SIGTERM"); assert.equal((await replacement.closed).code, 0, replacement.output.join(""));
      } else {
        const ownerFile = path.join(root, "daemon/owner.json");
        const original = fs.readFileSync(ownerFile);
        const altered = JSON.parse(original);
        altered.generation = randomUUID();
        fs.writeFileSync(ownerFile, JSON.stringify(altered));
        signal(owner.saved, "SIGTERM");
        assert.equal((await owner.closed).code, 1);
        assert.match(owner.output.join(""), /OWNER_CHANGED/);
        assert.ok(fs.lstatSync(path.join(root, "daemon/channel-api.sock")).isSocket(), "old generation must not delete replacement endpoint");
        fs.writeFileSync(ownerFile, original);
        owner = daemon(); await ready();
        assert.deepEqual(await call(root, "mission.result", { requestId: "one" }), outcome, "owner restart must retain exact outcome");
        signal(owner.saved, "SIGTERM"); assert.equal((await owner.closed).code, 0, owner.output.join(""));
        fs.writeFileSync(path.join(root, "daemon/channel-api.sock"), "not a socket");
        const unsafe = daemon();
        assert.equal((await unsafe.closed).code, 1);
        assert.match(unsafe.output.join(""), /OWNER_UNKNOWN/);
        assert.equal(fs.readFileSync(path.join(root, "daemon/channel-api.sock"), "utf8"), "not a socket");
        fs.unlinkSync(path.join(root, "daemon/channel-api.sock"));
      }
      assert.equal(fs.existsSync(path.join(root, "daemon/channel-api.sock")), false);
      assert.equal(journal.load(root).events.some((e) => ["integration.completed", "candidate.created", "release.evaluated"].includes(e.type)), false);
      evidence.push({ stage, request: load(root).requests.get("one") || null, barrier: captured || null });
    } catch (e) { error = e; }
    finally {
      // All targets are current identities of these newly-created finite fixtures.
      for (const proc of tracked.filter((p) => p !== watchdog)) {
        if (same(proc.saved)?.state !== "Z") signal(proc.saved, "SIGTERM");
      }
      await Promise.all(tracked.filter((p) => p !== watchdog).map((p) => p.closed));
      watchdog.child.send("finish"); await watchdog.closed;
      const cleanup = JSON.parse(fs.readFileSync(report));
      assert.deepEqual(cleanup.interventions, []); assert.deepEqual(cleanup.remaining, []);
      if (error) {
        for (const proc of tracked) if (proc.output.length) console.error(proc.output.join(""));
        throw error;
      }
      evidence.at(-1).cleanup = cleanup;
    }
    console.log("OWNER consumer PASS", stage);
  }
  const output = path.resolve("outputs/M0.2-OWNER");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "consumer-evidence.json"), JSON.stringify(evidence, null, 2));
  console.log("OWNER consumer total", evidence.length, "watchdog interventions 0; active remaining 0");
}
