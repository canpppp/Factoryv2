"use strict";

const assert = require("node:assert");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const report = require("../src/report");
const H = require("./helpers");

async function proveMultiMissionDependencyOrdering() {
  const root = H.tmp("factoryv2-prod-multi-");
  const repo = H.makeBugRepo();
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  const adapter = fakeAdapter({
    scripts: {
      "MISSION mission-alpha": [
        { type: "write", path: "docs/alpha.md", content: "alpha\n" },
        { type: "say", text: "alpha done" }
      ],
      "MISSION mission-beta": [
        { type: "write", path: "docs/beta.md", content: "beta\n" },
        { type: "say", text: "beta done" }
      ],
      "REVIEW mission-alpha": [{ type: "say", text: approve }],
      "REVIEW mission-beta": [{ type: "say", text: approve }]
    }
  });
  const c = createController({ root, adapter });
  c.enqueueGoal({
    goal: "Create dependent docs missions",
    repo,
    missionOverrides: {
      missions: [
        { id: "mission-alpha", title: "Alpha", branch: "factory/alpha", ownedFiles: ["docs/**"], verifyCommands: ["test -f docs/alpha.md"] },
        { id: "mission-beta", title: "Beta", branch: "factory/beta", ownedFiles: ["docs/**"], verifyCommands: ["test -f docs/beta.md"], dependsOn: ["mission-alpha"] }
      ]
    }
  });
  await c.run({ maxSteps: 50 });
  const state = journal.load(root);
  assert.strictEqual(state.missions.get("mission-alpha").state, "ready_for_human_check");
  assert.strictEqual(state.missions.get("mission-beta").state, "ready_for_human_check");
  const alphaAccepted = state.events.findIndex((e) => e.type === "mission.state" && e.missionId === "mission-alpha" && e.to === "ready_for_human_check");
  const betaBuild = state.events.findIndex((e) => e.type === "mission.state" && e.missionId === "mission-beta" && e.to === "building");
  assert.ok(alphaAccepted >= 0 && betaBuild > alphaAccepted, "dependent mission started before dependency reached human-check readiness");
}

async function proveWorkerReplacement() {
  await proveLostThreadReplacement();
  await proveMalformedOrTimeoutReplacement("MALFORMED_WORKER_RESPONSE", [{ type: "say", text: "MALFORMED_WORKER_RESPONSE" }]);
  await proveMalformedOrTimeoutReplacement("TIMEOUT", [{ type: "timeout", message: "simulated timeout" }]);
}

async function proveLostThreadReplacement() {
  const root = H.tmp("factoryv2-prod-lost-");
  const repo = H.makeBugRepo();
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  let workerTurns = 0;
  const adapter = fakeAdapter({
    scripts: {
      "MISSION mission-": () => {
        workerTurns++;
        if (workerTurns === 1) return [
          { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
          { type: "say", text: "fixed" }
        ];
        return [
          { type: "write", path: "README.md", content: "Lost worker replacement completed with durable handoff.\n" },
          { type: "say", text: "handoff repair complete" }
        ];
      },
      "REVIEW mission-": [{ type: "say", text: approve }]
    }
  });
  const c = createController({ root, adapter });
  c.enqueueGoal({ goal: "Replace lost worker", repo });
  await c.run({ maxSteps: 2 });
  let state = journal.load(root);
  const mission = [...state.missions.values()][0];
  journal.append(root, { type: "mission.state", missionId: mission.id, from: mission.state, to: "repair" });
  adapter._threads.delete(mission.workerThreadId);
  await c.run({ maxSteps: 20 });
  state = journal.load(root);
  const finalMission = state.missions.get(mission.id);
  assert.strictEqual(finalMission.state, "ready_for_human_check");
  assert.ok(state.events.some((e) => e.type === "worker.replaced" && e.reason === "THREAD_NOT_FOUND"));
}

async function proveMalformedOrTimeoutReplacement(reason, firstSteps) {
  const root = H.tmp(`factoryv2-prod-${reason.toLowerCase()}-`);
  const repo = H.makeBugRepo();
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  let workerTurns = 0;
  const adapter = fakeAdapter({
    scripts: {
      "MISSION mission-": () => {
        workerTurns++;
        if (workerTurns === 1) return firstSteps;
        return [
          { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
          { type: "say", text: "fixed after replacement" }
        ];
      },
      "REVIEW mission-": [{ type: "say", text: approve }]
    }
  });
  const c = createController({ root, adapter });
  c.enqueueGoal({ goal: `Recover from ${reason}`, repo });
  await c.run({ maxSteps: 30 });
  const state = journal.load(root);
  const mission = [...state.missions.values()][0];
  assert.strictEqual(mission.state, "ready_for_human_check");
  assert.ok(state.events.some((e) => e.type === "worker.replaced" && e.reason === reason), `missing replacement event for ${reason}`);
}

function proveEvidenceIntegrity() {
  const root = H.tmp("factoryv2-prod-report-");
  journal.append(root, { type: "mission.created", missionId: "mission-report", mission: { title: "Report", repo: "fake", branch: "factory/report" } });
  journal.append(root, { type: "mission.state", missionId: "mission-report", from: "queued", to: "ready_for_human_check" });
  journal.append(root, { type: "verification.finished", missionId: "mission-report", results: [{ command: "npm test", passed: false, exitCode: 1 }] });
  journal.append(root, { type: "acceptance.finished", missionId: "mission-report", results: [{ command: "npm test", passed: false, exitCode: 1 }] });
  journal.append(root, { type: "receipt", missionId: "mission-report", status: "READY_FOR_HUMAN_CHECK", summary: "PASS npm test" });
  const state = journal.load(root);
  const r = report.missionReport(state, "mission-report");
  assert.strictEqual(r.machineOk, false);
  assert.match(r.text, /FAIL gate npm test/);
  assert.doesNotMatch(r.text, /^PASS/m);
}

async function main() {
  await proveMultiMissionDependencyOrdering();
  await proveWorkerReplacement();
  proveEvidenceIntegrity();
  console.log("Production contract proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
