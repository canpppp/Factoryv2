"use strict";
if (process.platform !== "linux") console.log("NOT_TESTED: GOAL Linux CLI/daemon consumers; no host sandbox");
else main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });

async function main() {
  const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
  const { fork } = require("node:child_process"), { randomUUID } = require("node:crypto");
  const H = require("./helpers"), journal = require("../src/journal");
  const { createController, planGoal } = require("../src/controller");
  const { load } = require("../src/mission-requests"), { read } = require("../src/execution-owner");
  const { call, exchange } = require("../src/owner-client");
  const { fixtureProfile } = require("./fixtures/isolated-profile");
  const { identity, same, signal, inventory } = require("./fixtures/linux-ownership-host");
  async function until(fn, ms = 6000) {
    const end = Date.now() + ms;
    do { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 10)); } while (Date.now() < end);
    throw new Error("GOAL bounded barrier timed out");
  }
  const evidence = [];
  for (const mode of ["cli-flow", "multi-interruption"]) {
    const root = H.tmp("fg-"), control = H.tmp("fgc-"), repo = H.makeBugRepo(), token = randomUUID();
    const expiry = Date.now() + 28000, report = path.join(control, "watchdog.json"), configPath = path.join(control, "config.json");
    const config = { root, control, expiry, stage: mode === "multi-interruption" ? "prepare-partial" : "before-ready" };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const tracked = [];
    function start(file, args) {
      const child = fork(path.join(__dirname, "fixtures", file), args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const output = [], messages = [];
      child.stdout.on("data", (chunk) => output.push(chunk.toString()));
      child.stderr.on("data", (chunk) => output.push(chunk.toString()));
      child.on("message", (message) => messages.push(message));
      const proc = { child, output, messages, saved: identity(child.pid), closed: new Promise((resolve) => child.on("close", (code, sig) => resolve({ code, signal: sig }))) };
      tracked.push(proc); return proc;
    }
    const watchdog = start("linux-ownership-watchdog.js", [token, String(expiry - 1000), report]);
    await until(() => watchdog.messages.length);
    let failure, record;
    try {
      journal.ensure(root);
      const provider = fixtureProfile(path.join(__dirname, "fixtures/owner-worker.js"));
      const worktrees = path.join(root, "worktrees");
      const policies = Object.fromEntries(["worker", "reviewer"].map((role) => [role, {
        ...provider, engine: "claude", model: "fixture", allowedTools: role === "worker" ? ["Read", "Write"] : ["Read"],
        workerPolicy: { ...provider.workerPolicy, readRoots: [worktrees], writeRoots: role === "worker" ? [worktrees] : [], timeoutMs: 7000, limits: { killGraceMs: 100, cleanupMs: 2000 } }
      }]));
      const policyPath = path.join(root, "operator.json");
      fs.writeFileSync(policyPath, JSON.stringify(policies), { mode: 0o600 });
      const client = (...args) => start("owner-entry.js", [configPath, token, "client", ...args, "--root", root]);
      async function cli(...args) {
        const p = client(...args), exit = await p.closed;
        assert.equal(exit.code, 0, p.output.join("")); return p.output.join("").trim();
      }
      const enqueue = async (text) => (await cli("goal", text, "--repo", repo)).replace(/^queued /, "");
      const goalId = mode === "cli-flow" ? await enqueue("prepare this exact goal")
        : createController({ root }).enqueueGoal({ goal: "trusted multi mission fixture", repo, missionOverrides: { missions: [
          { id: "multi-first", maxRepairRounds: 0, budget: { tokens: 900 }, effects: ["read"], jobPack: { ref: "pack" }, priming: { ref: "prime" }, verifyCommands: [] },
          { id: "multi-second", dependsOn: ["multi-first"], ownedFiles: ["docs/**"] }
        ] } }).id;
      const unrelated = await enqueue("leave unrelated goal queued");
      assert.equal(journal.load(root).missions.size, 0, "enqueue cannot hide preparation");
      const params = { goalId, requestId: "prepare-one" };
      const prepareArgs = ["prepare", "--goal", goalId, "--request-id", "prepare-one"];
      const missing = client(...prepareArgs);
      assert.equal((await missing.closed).code, 1); assert.match(missing.output.join(""), /OWNER_UNAVAILABLE/);
      const daemon = () => start("owner-entry.js", [configPath, token, "daemon", "--root", root, "--role-policies", policyPath, "--poll-ms", "10"]);
      const ready = () => until(async () => {
        const owner = read(root); if (!owner?.ready) return false;
        try { return (await exchange(owner.endpoint, "GET")).ok; } catch { return false; }
      });
      let owner = daemon();
      if (mode === "cli-flow") {
        await until(() => fs.existsSync(path.join(control, "before-ready")));
        const notReady = client(...prepareArgs);
        assert.equal((await notReady.closed).code, 1); assert.match(notReady.output.join(""), /OWNER_NOT_READY/);
        assert.equal(journal.load(root).preparations.size, 0);
        fs.writeFileSync(path.join(control, "release-before-ready"), "");
      }
      await ready();
      const plan = planGoal(journal.load(root).goals.get(goalId));
      if (mode === "cli-flow") {
        const one = client(...prepareArgs), two = client(...prepareArgs);
        assert.equal((await one.closed).code, 0, one.output.join(""));
        assert.equal((await two.closed).code, 0, two.output.join(""));
        const prepared = JSON.parse(one.output.join(""));
        assert.deepEqual(JSON.parse(two.output.join("")), prepared);
        assert.deepEqual(await call(root, "mission.prepare", params), prepared);
        assert.deepEqual(prepared.missionIds, plan.map((p) => p.missionId));
        assert.equal(prepared.status, "prepared"); assert.equal(prepared.objectiveCompleted, false);
        const state = journal.load(root);
        assert.deepEqual(fs.readdirSync(worktrees), []);
        assert.equal(state.events.some((e) => e.type === "mission.role.session"), false);
        assert.deepEqual(state.events.find((e) => e.type === "mission.created").mission, plan[0].mission);
        await assert.rejects(call(root, "mission.prepare", { ...params, goalId: unrelated }), { code: "REQUEST_CONFLICT" });
        await assert.rejects(call(root, "mission.prepare", { ...params, requestId: "different" }), { code: "GOAL_ALREADY_PREPARED" });
        await assert.rejects(call(root, "mission.prepare", { requestId: "unknown", goalId: "unknown" }), { code: "GOAL_NOT_FOUND" });
        const blocked = await enqueue("Update credential handling boundary docs");
        await assert.rejects(call(root, "mission.prepare", { requestId: "blocked", goalId: blocked }), { code: "GOAL_NOT_PREPARABLE" });
        for (const denied of [{ env: {} }, { rolePolicies: policies }, { allowedTools: ["Bash"] }, { missionOverrides: {} }]) {
          await assert.rejects(call(root, "mission.prepare", { ...params, ...denied }), { code: "REQUEST_INVALID" });
        }
        const invalidCli = client(...prepareArgs, "--local-test");
        assert.equal((await invalidCli.closed).code, 1); assert.match(invalidCli.output.join(""), /REQUEST_INVALID/);
        const info = read(root);
        const stale = await exchange(info.endpoint, "POST", { method: "mission.prepare", params, owner: { generation: "stale", root } });
        assert.equal(stale.error.code, "OWNER_CHANGED");
        const wrong = H.tmp("fg-wrong-"); journal.ensure(wrong);
        fs.copyFileSync(path.join(root, "daemon/owner.json"), path.join(wrong, "daemon/owner.json"));
        await assert.rejects(call(wrong, "mission.prepare", params), { code: "OWNER_WRONG_ROOT" });
        const missionId = prepared.missionIds[0];
        const run = client("run", "--mission", missionId, "--request-id", "run-one", "--max-steps", "1", "--wait");
        const mission = await until(() => {
          const m = journal.load(root).missions.get(missionId);
          return m.worktree && fs.existsSync(path.join(m.worktree, "worker-entered")) && m;
        });
        signal(run.saved, "SIGKILL"); await run.closed;
        fs.writeFileSync(path.join(mission.worktree, "worker-release"), "");
        await until(() => load(root).requests.get("run-one")?.status === "finished");
        const result = JSON.parse(await cli("result", "--request-id", "run-one"));
        assert.deepEqual(result, load(root).requests.get("run-one"));
        assert.equal(result.outcome.execution.ok, true); assert.equal(result.outcome.missionState, "verifying");
        assert.equal(result.outcome.roleSessions.worker.status, "settled");
        assert.equal(fs.readFileSync(path.join(mission.worktree, "worker-entered"), "utf8"), "invocation\n");
        assert.deepEqual(JSON.parse(await cli("result", "--request-id", "prepare-one")), prepared);
        assert.equal(journal.load(root).events.filter((e) => e.type === "mission.created").length, 1);
        const multi = createController({ root }).enqueueGoal({ goal: "stored template preservation", repo, missionOverrides: { missions: [
          { id: "metadata-one", maxRepairRounds: 0, budget: { tokens: 900 }, effects: ["read"], jobPack: { ref: "pack" }, priming: { ref: "prime" }, verifyCommands: [] },
          { id: "metadata-two", dependsOn: ["metadata-one"], ownedFiles: ["docs/**"] }
        ] } });
        const multiPlan = planGoal(journal.load(root).goals.get(multi.id));
        const mapping = JSON.parse(await cli("prepare", "--goal", multi.id, "--request-id", "multi-success"));
        assert.deepEqual(mapping.missionIds, ["metadata-one", "metadata-two"]);
        for (const item of multiPlan) assert.deepEqual(journal.load(root).events.find((e) => e.type === "mission.created" && e.missionId === item.missionId).mission, item.mission);
        assert.equal(journal.load(root).events.filter((e) => e.type === "mission.role.session" && e.missionId !== missionId).length, 0);
        record = { mode, preparation: prepared, execution: result, multiMapping: mapping };
      } else {
        const preparing = client(...prepareArgs);
        await until(() => fs.existsSync(path.join(control, "prepare-partial")));
        const state = journal.load(root);
        assert.equal(state.preparations.get("prepare-one").status, "preparing");
        assert.equal(state.missions.size, 1); assert.equal(state.missions.get("multi-first").state, "preparing");
        assert.deepEqual(state.events.find((e) => e.type === "mission.created").mission, plan[0].mission);
        assert.deepEqual(fs.readdirSync(worktrees), []);
        signal(preparing.saved, "SIGKILL"); await preparing.closed;
        signal(owner.saved, "SIGKILL"); await owner.closed;
        fs.writeFileSync(configPath, JSON.stringify({ ...config, stage: "restarted" }));
        owner = daemon(); await ready();
        const quarantined = await call(root, "mission.prepare", params);
        assert.equal(quarantined.status, "blocked");
        assert.deepEqual(quarantined.missionIds, ["multi-first", "multi-second"]);
        await assert.rejects(call(root, "mission.run", { requestId: "partial-run", missionId: "multi-first" }), { code: "PREPARATION_BLOCKED" });
        await assert.rejects(call(root, "mission.prepare", { ...params, requestId: "retry" }), { code: "GOAL_ALREADY_PREPARED" });
        const collision = createController({ root }).enqueueGoal({ goal: "reserved identity collision", repo, missionOverrides: { id: "multi-second" } });
        await assert.rejects(call(root, "mission.prepare", { requestId: "collision", goalId: collision.id }), { code: "MISSION_ID_COLLISION" });
        assert.equal(journal.load(root).events.filter((e) => e.type === "mission.created").length, 1);
        assert.equal(journal.load(root).missions.has("multi-second"), false);
        assert.deepEqual(fs.readdirSync(worktrees), []);
        record = { mode, preparation: quarantined, createdMissions: 1, workerInvocations: 0 };
      }
      assert.equal(journal.load(root).goals.get(unrelated).state, "queued");
      assert.equal(journal.load(root).events.some((e) => /integration\.|candidate\.|release\.|review.finished/.test(e.type)), false);
      signal(owner.saved, "SIGTERM"); assert.equal((await owner.closed).code, 0, owner.output.join(""));
      assert.equal(fs.existsSync(path.join(root, "daemon/channel-api.sock")), false);
    } catch (error) { failure = error; }
    finally {
      for (const p of tracked.filter((p) => p !== watchdog)) if (same(p.saved)?.state !== "Z") signal(p.saved, "SIGTERM");
      await Promise.all(tracked.filter((p) => p !== watchdog).map((p) => p.closed));
      await until(() => inventory(token).filter((p) => p.pid !== watchdog.child.pid && p.state !== "Z").length === 0);
      watchdog.child.send("finish"); await watchdog.closed;
      const cleanup = JSON.parse(fs.readFileSync(report));
      assert.deepEqual(cleanup.interventions, []); assert.deepEqual(cleanup.remaining, []);
      if (failure) { tracked.forEach((p) => { if (p.output.length) console.error(p.output.join("")); }); throw failure; }
      evidence.push({ ...record, cleanup });
    }
    console.log("GOAL consumer PASS", mode);
  }
  console.log("GOAL_EVIDENCE_JSON " + JSON.stringify(evidence));
}
