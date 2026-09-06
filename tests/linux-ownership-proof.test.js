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
  const { identity, same, inventory, signal } = require("./fixtures/linux-ownership-host");
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
  for (const mode of ["cancel", "timeout", "overflow", "exit", "owner-loss"]) {
    const dir = H.tmp("factory-linux-owned-");
    const token = randomUUID(), expiry = Date.now() + 18000;
    const provider = fixtureProfile(path.join(__dirname, "fixtures/linux-ownership-worker.js"), { readRoots: [dir], writeRoots: [dir] });
    const configPath = path.join(dir, "config.json"), report = path.join(dir, "watchdog.json");
    fs.writeFileSync(configPath, JSON.stringify({ dir, expiry, provider, mode, timeoutMs: mode === "timeout" ? 1800 : 8000, limits: { lineBytes: 1024, killGraceMs: 100, cleanupMs: 2000 } }));
    const watchdog = start("linux-ownership-watchdog.js", [token, String(expiry - 2000), report]);
    await until(() => watchdog.messages.length);
    const owner = start("linux-ownership-owner.js", [configPath, token]);
    // A separate, bounded control process does not share the test identity/namespace.
    const control = fork(path.join(__dirname, "fixtures/linux-ownership-control.js"), [String(expiry), token], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const controlClosed = new Promise((resolve) => control.on("close", resolve));
    const controlIdentity = identity(control.pid);
    const namespaces = new Set();
    let captured = [], atSettlement = [], result, testError;
    try {
      await until(() => fs.existsSync(path.join(dir, "grandchild.json")));
      const locals = ["leader", "child", "grandchild"].map((role) => JSON.parse(fs.readFileSync(path.join(dir, `${role}.json`))));
      assert.ok(locals.every((item) => item.token === token));
      const hostNamespace = identity(process.pid).namespace;
      captured = inventory(token).filter((item) => item.pid !== watchdog.child.pid);
      captured.forEach((item) => { if (item.namespace && item.namespace !== hostNamespace) namespaces.add(item.namespace); });
      assert.equal(namespaces.size, 1, "one owned worker PID namespace");
      captured = inventory(token, [...namespaces]).filter((item) => item.pid !== watchdog.child.pid);
      const workers = captured.filter((item) => namespaces.has(item.namespace) && item.state !== "Z");
      assert.ok(workers.length >= 4, "host sees namespace init plus worker, detached child and grandchild");
      assert.ok(new Set(workers.map((item) => item.session)).size >= 3, "descendants really created separate sessions");
      fs.writeFileSync(path.join(dir, "go"), "go");
      if (mode === "owner-loss") {
        assert.equal(signal(owner.saved, "SIGKILL"), true);
        await owner.closed;
        await until(() => inventory(token, [...namespaces]).filter((item) => namespaces.has(item.namespace) && item.state !== "Z").length === 0);
        assert.equal(owner.messages.filter((item) => item.type === "settled").length, 0, "owner loss is not successful job completion");
      } else {
        if (mode === "cancel") { owner.child.send("cancel"); owner.child.send("cancel"); }
        if (mode === "overflow") await until(() => owner.messages.some((item) => item.type === "settled"));
        result = (await until(() => owner.messages.find((item) => item.type === "settled"))).result;
        atSettlement = inventory(token, [...namespaces]).filter((item) => namespaces.has(item.namespace) && item.state !== "Z");
        assert.deepEqual(atSettlement, [], "settlement cannot precede active namespace cleanup");
        assert.equal(result.cause, { cancel: "CANCELLED", timeout: "TIMEOUT", overflow: "OUTPUT_LIMIT", exit: "EXIT" }[mode]);
        if (mode === "overflow" || mode === "timeout") owner.child.send("cancel");
        await sleep(80);
        assert.equal(owner.messages.filter((item) => item.type === "settled").length, 1);
        assert.ok(!result.events.some((item) => item.type === "late-success"));
        assert.ok(result.events.every((item) => item.token === token));
        assert.ok(same(owner.saved), "execution owner remains alive after settlement");
      }
      assert.equal(same(controlIdentity)?.state === "Z", false, "unrelated control survives");
      assert.ok(same(controlIdentity));
    } catch (error) { testError = error; }
    finally {
      if (owner.child.connected) { owner.child.send("cancel"); owner.child.send("finish"); }
      // On a failed proof the independent watchdog owns last-resort cleanup.
      if (testError) await watchdog.closed;
      await owner.closed;
      if (control.connected) control.send("finish"); await controlClosed;
      if (watchdog.child.connected) watchdog.child.send("finish");
      await watchdog.closed;
    }
    const guarded = JSON.parse(fs.readFileSync(report));
    evidence.push({ mode, captured, namespaces: [...namespaces], atSettlement, result, watchdog: guarded, control: controlIdentity, error: testError?.message });
    console.log("OWNERSHIP_EVIDENCE", JSON.stringify(evidence.at(-1)));
    assert.deepEqual(guarded.interventions, [], "watchdog intervention is failure, never certified cleanup");
    assert.deepEqual(guarded.remaining, []);
    if (testError) throw testError;
  }
  console.log("Linux whole-namespace ownership fixtures PASS (synthetic, no provider acceptance)");
}
