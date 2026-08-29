"use strict";

const assert = require("node:assert");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const H = require("./helpers");

function adapterWithReview({ rejectFirst = false } = {}) {
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  const reject = JSON.stringify({ verdict: "reject", findings: ["add repair evidence"], summary: "repair" });
  let workerTurns = 0;
  return fakeAdapter({
    scripts: {
      "MISSION mission-": () => {
        workerTurns++;
        if (workerTurns === 1) return [
          { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
          { type: "say", text: "implemented" }
        ];
        return [
          { type: "write", path: "README.md", content: "repair evidence\n" },
          { type: "say", text: "repaired" }
        ];
      },
      "REVIEW mission-": ({ round }) => [{ type: "say", text: rejectFirst && round === 1 ? reject : approve }]
    }
  });
}

async function runWithRestartAt(stepCount, expectedState, options = {}) {
  const root = H.tmp(`factoryv2-phase-${expectedState}-`);
  const repo = H.makeBugRepo();
  const adapter = adapterWithReview(options);
  const first = createController({ root, adapter });
  first.enqueueGoal({
    goal: `Restart at ${expectedState}`,
    repo,
    missionOverrides: {
      acceptanceCommands: ["node -e \"const {add}=require('./src/add'); if(add(2,3)!==5) process.exit(1)\""]
    }
  });
  await first.run({ maxSteps: stepCount });
  let state = journal.load(root);
  const mission = [...state.missions.values()][0];
  assert.strictEqual(mission.state, expectedState);

  const second = createController({ root, adapter });
  await second.run({ maxSteps: 30 });
  state = journal.load(root);
  assert.strictEqual(state.missions.get(mission.id).state, "ready_for_human_check");
}

async function main() {
  await runWithRestartAt(1, "queued");
  await runWithRestartAt(2, "verifying");
  await runWithRestartAt(3, "reviewing");
  await runWithRestartAt(4, "repair", { rejectFirst: true });
  console.log("Phase restart proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
