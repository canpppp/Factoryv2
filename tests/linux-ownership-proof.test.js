"use strict";

// No subprocess, namespace, signal or sandbox operation is permitted on Darwin.
if (process.platform !== "linux") {
  console.log("NOT_TESTED: Linux namespace ownership proof (no host sandbox operations)");
} else {
  main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}

async function main() {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { fork, spawnSync } = require("node:child_process");
  const { randomUUID } = require("node:crypto");
  const { identity, same, inventory, signal, pin } = require("./fixtures/linux-ownership-host");
  const { fixtureProfile } = require("./fixtures/isolated-profile");
  const H = require("./helpers");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(fn, ms = 4000) {
    const deadline = Date.now() + ms;
    do { const value = fn(); if (value) return value; await sleep(10); } while (Date.now() < deadline);
    throw new Error("bounded ownership observation timed out");
  }
  function start(file, args) {
    const child = fork(path.join(__dirname, "fixtures", file), args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const messages = [], output = [];
    child.on("message", (message) => messages.push(message));
    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));
    const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    return { child, messages, output, closed, saved: identity(child.pid) };
  }
  console.log("Linux ownership backend:", spawnSync("/usr/bin/bwrap", ["--version"], { encoding: "utf8" }).stdout.trim());
  const evidence = [];
  for (const mode of ["cancel", "timeout", "overflow", "exit", "owner-loss", "client-loss", "channel-cancel", "cleanup-unknown", "race", "info-malformed", "observation-held"]) {
    const dir = H.tmp("factory-linux-owned-");
    const token = randomUUID(), expiry = Date.now() + 18000;
    const provider = fixtureProfile(path.join(__dirname, "fixtures/linux-ownership-worker.js"), { readRoots: [dir], writeRoots: [dir], limits: { killGraceMs: 100, cleanupMs: 2000 } });
    const configPath = path.join(dir, "config.json"), report = path.join(dir, "watchdog.json");
    const channel = ["client-loss", "channel-cancel", "cleanup-unknown"].includes(mode);
    const root = H.tmp("factory-linux-api-");
    const config = { dir, root, expiry, provider, mode, timeoutMs: mode === "info-malformed" ? 1000 : ["timeout", "race"].includes(mode) ? 1800 : 8000, limits: { lineBytes: 1024, killGraceMs: 100, cleanupMs: 2000 } };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const watchdog = start("linux-ownership-watchdog.js", [token, String(expiry - 2000), report]);
    await until(() => watchdog.messages.length);
    const owner = start(channel ? "linux-ownership-daemon.js" : "linux-ownership-owner.js", [configPath, token]);
    // A separate, bounded control process does not share the test identity/namespace.
    const control = fork(path.join(__dirname, "fixtures/linux-ownership-control.js"), [String(expiry), token], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const controlClosed = new Promise((resolve) => control.on("close", resolve));
    const controlIdentity = identity(control.pid);
    const namespaces = new Set();
    const namespacePins = [];
    let captured = [], atSettlement = [], result, testError, client, attempt, replacement;
    try {
      if (channel) {
        const api = await until(() => owner.messages.find((item) => item.type === "api"));
        await until(() => fs.existsSync(api.socketPath));
        client = start("linux-ownership-client.js", [configPath, token, api.socketPath]);
        const queued = await until(() => client.messages.find((item) => item.type === "queued"));
        assert.equal(queued.response.ok, true, JSON.stringify(queued));
      }
      if (mode === "info-malformed") {
        const settlement = await until(() => owner.messages.find((item) => item.type === "settled"));
        result = settlement.result;
        assert.equal(result.cause, "CLEANUP_FAILED");
        assert.equal(result.ownership.state, "UNKNOWN");
        assert.equal(fs.existsSync(path.join(dir, "leader.json")), false, "unobserved namespace must never release worker execution");
      } else {
      await until(() => fs.existsSync(path.join(dir, "grandchild.json")));
      const locals = ["leader", "child", "grandchild"].map((role) => JSON.parse(fs.readFileSync(path.join(dir, `${role}.json`))));
      assert.ok(locals.every((item) => item.token === token));
      const hostNamespace = identity(process.pid).namespace;
      captured = inventory(token).filter((item) => item.pid !== watchdog.child.pid);
      captured.forEach((item) => {
        if (item.namespace && item.namespace !== hostNamespace && !namespaces.has(item.namespace)) {
          namespacePins.push(pin(item)); namespaces.add(item.namespace);
        }
      });
      assert.equal(namespaces.size, 1, "one owned worker PID namespace");
      captured = inventory(token, [...namespaces]).filter((item) => item.pid !== watchdog.child.pid);
      const workers = captured.filter((item) => namespaces.has(item.namespace) && item.state !== "Z");
      assert.ok(workers.length >= 4, "host sees namespace init plus worker, detached child and grandchild");
      const init = workers.find((item) => item.namespacePids.at(-1) === 1);
      const monitor = identity(init.ppid);
      assert.equal(monitor.ppid, owner.child.pid, "namespace init -> bwrap monitor -> exact execution owner");
      if (!captured.some((item) => item.pid === monitor.pid)) captured.push(monitor);
      assert.ok(new Set(workers.map((item) => item.session)).size >= 3, "descendants really created separate sessions");
      for (const local of locals.slice(1)) {
        const descendant = workers.find((item) => item.namespacePids.at(-1) === local.pid);
        assert.ok(descendant, "each namespace-local fixture identity maps to a host PID/start time");
        assert.equal(fs.readlinkSync(`/proc/${descendant.pid}/fd/1`), "/dev/null", "detached descendant closed inherited output pipe");
        signal(descendant, "SIGTERM");
        await sleep(25);
        assert.ok(same(descendant) && same(descendant).state !== "Z", "fixture really ignores TERM");
      }
      if (mode === "client-loss") {
        assert.equal(signal(client.saved, "SIGKILL"), true);
        await client.closed;
        await sleep(80);
        assert.ok(same(owner.saved), "daemon owner survives outer client loss");
        assert.ok(inventory(token, [...namespaces]).some((item) => namespaces.has(item.namespace) && item.state !== "Z"), "job remains alive after client death");
      }
      if (mode === "race") {
        const spawn = owner.messages.find((item) => item.type === "spawn");
        await sleep(Math.max(0, spawn.deadline - Date.now() - 5));
      }
      fs.writeFileSync(path.join(dir, "go"), "go");
      if (mode === "owner-loss") {
        assert.equal(signal(owner.saved, "SIGKILL"), true);
        await owner.closed;
        await until(() => inventory(token, [...namespaces]).filter((item) => namespaces.has(item.namespace) && item.state !== "Z").length === 0);
        assert.equal(owner.messages.filter((item) => item.type === "settled").length, 0, "owner loss is not successful job completion");
      } else {
        if (["cancel", "channel-cancel", "cleanup-unknown", "race", "observation-held"].includes(mode)) { owner.child.send("cancel"); owner.child.send("cancel"); }
        if (mode === "overflow") await until(() => owner.messages.some((item) => item.type === "settled"));
        const settlement = await until(() => owner.messages.find((item) => item.type === "settled"));
        result = settlement.result;
        attempt = settlement.attempt;
        if (mode === "observation-held") assert.ok(settlement.afterCancelMs >= 200, "settlement must wait for namespace termination observation, not just monitor exit");
        atSettlement = inventory(token, [...namespaces]).filter((item) => namespaces.has(item.namespace) && item.state !== "Z");
        assert.deepEqual(atSettlement, [], "settlement cannot precede active namespace cleanup");
        if (!channel) {
          assert.equal(result.ownership.state, "TERMINATED");
          assert.equal(result.ownership.init.pid, init.pid);
          assert.equal(result.ownership.init.startTime, init.start);
          assert.equal(result.ownership.init.namespace, init.namespace);
          assert.equal(settlement.namespaces.length, 1, "owner observed containment before settlement");
          assert.deepEqual(settlement.atSettlement, [], "wrapper promise settlement has no active owned namespace member");
          if (mode === "race") assert.ok(["CANCELLED", "TIMEOUT", "OUTPUT_LIMIT"].includes(result.cause));
          else assert.equal(result.cause, { cancel: "CANCELLED", timeout: "TIMEOUT", overflow: "OUTPUT_LIMIT", exit: "EXIT", "observation-held": "CANCELLED" }[mode]);
        } else if (mode === "client-loss") assert.equal(result.ok, true, JSON.stringify(result));
        else {
          assert.equal(attempt.code, mode === "cleanup-unknown" ? "CLEANUP_FAILED" : "CANCELLED");
          assert.equal(attempt.receipt.sessionId, null, "cancel precedes any provider session ID");
          assert.equal(attempt.receipt.metadata.ownedRunSettled, mode !== "cleanup-unknown");
          assert.equal(attempt.receipt.metadata.externalEffects, "UNKNOWN");
        }
        if (mode === "overflow" || mode === "timeout") owner.child.send("cancel");
        await sleep(80);
        assert.equal(owner.messages.filter((item) => item.type === "settled").length, 1);
        if (!channel) {
          assert.ok(!result.events.some((item) => item.type === "late-success"));
          assert.ok(result.events.every((item) => item.token === token));
        }
        assert.ok(same(owner.saved), "execution owner remains alive after settlement");
        if (mode === "cleanup-unknown") {
          const { createChannelRegistry } = require("../src/channels");
          const restarted = createChannelRegistry({ root, definitionsPath: path.join(root, "channels.json") });
          restarted.ensureDefaults();
          for (const action of [() => restarted.send("proof", "retry"), () => restarted.resume("proof")]) assert.throws(action, { code: "WORKER_CLEANUP_BLOCKED" });
          assert.equal(restarted.status("proof").workerBlocked.code, "CLEANUP_FAILED");
        }
        if (mode === "channel-cancel") {
          client.child.send("finish"); await client.closed;
          const nextDir = path.join(dir, "next"); fs.mkdirSync(nextDir);
          const nextConfig = path.join(dir, "next-config.json");
          fs.writeFileSync(nextConfig, JSON.stringify({ ...config, dir: nextDir, mode: "client-loss" }));
          const api = owner.messages.find((item) => item.type === "api");
          client = start("linux-ownership-client.js", [nextConfig, token, api.socketPath]);
          await until(() => fs.existsSync(path.join(nextDir, "grandchild.json")));
          await sleep(30);
          assert.equal(owner.messages.filter((item) => item.type === "settled").length, 1, "late first-attempt output cannot finish replacement");
          fs.writeFileSync(path.join(nextDir, "go"), "go");
          replacement = await until(() => owner.messages.filter((item) => item.type === "settled")[1]);
          assert.equal(replacement.result.ok, true, JSON.stringify(replacement));
          assert.notEqual(replacement.attempt.jobId, attempt.jobId);
          assert.notEqual(replacement.attempt.receipt.metadata.runId, attempt.receipt.metadata.runId);
          assert.equal(replacement.result.structured.jobId, replacement.attempt.jobId);
        }
      }
      }
      assert.equal(same(controlIdentity)?.state === "Z", false, "unrelated control survives");
      assert.ok(same(controlIdentity));
    } catch (error) { testError = error; }
    finally {
      if (owner.child.connected) { owner.child.send("cancel"); owner.child.send("finish"); }
      if (client?.child.connected) client.child.send("finish");
      if (client) await client.closed;
      if (control.connected) control.send("finish"); await controlClosed;
      // On a failed proof the independent watchdog owns last-resort cleanup.
      if (testError) await watchdog.closed;
      await owner.closed;
      if (watchdog.child.connected) watchdog.child.send("finish");
      await watchdog.closed;
      namespacePins.forEach((fd) => fs.closeSync(fd));
    }
    if (!fs.existsSync(report)) console.error("OWNERSHIP_HARNESS_FAILURE", JSON.stringify({ mode, testError: testError?.stack, owner: owner.output, ownerMessages: owner.messages, watchdog: watchdog.output, watchdogExit: await watchdog.closed }));
    const guarded = JSON.parse(fs.readFileSync(report));
    evidence.push({ mode, captured, namespaces: [...namespaces], atSettlement, result, attempt, replacement, watchdog: guarded, control: controlIdentity, error: testError?.message });
    console.log("OWNERSHIP_EVIDENCE", JSON.stringify(evidence.at(-1)));
    assert.deepEqual(guarded.interventions, [], "watchdog intervention is failure, never certified cleanup");
    assert.deepEqual(guarded.remaining, []);
    if (testError) throw testError;
  }
  console.log("Linux whole-namespace ownership fixtures PASS (synthetic, no provider acceptance)");
}
