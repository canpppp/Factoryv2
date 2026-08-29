"use strict";

const assert = require("node:assert");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const H = require("./helpers");

function adapter() {
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  return fakeAdapter({
    scripts: {
      "MISSION mission-": [
        { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
        { type: "say", text: "implemented" }
      ],
      "REVIEW mission-": [{ type: "say", text: approve }]
    }
  });
}

async function runToState(expectedState, maxSteps) {
  const root = H.tmp(`factoryv2-post-review-${expectedState}-`);
  const repo = H.makeBugRepo();
  const sharedAdapter = adapter();
  const c1 = createController({ root, adapter: sharedAdapter });
  c1.enqueueGoal({
    goal: `Restart in ${expectedState}`,
    repo,
    missionOverrides: {
      candidateSpec: {
        identity: "Restart Candidate",
        handshakeIdentity: "Restart Candidate",
        uiRuntime: "fake-ui",
        agentRuntime: "fake-agent",
        expectedAgentRuntime: "fake-agent",
        dependencies: ["node"]
      },
      acceptanceCommands: ["node -e \"const {add}=require('./src/add'); if(add(2,3)!==5) process.exit(1)\""]
    }
  });
  await c1.run({ maxSteps });
  let state = journal.load(root);
  const mission = [...state.missions.values()][0];
  assert.strictEqual(mission.state, expectedState);
  const c2 = createController({ root, adapter: sharedAdapter });
  await c2.run({ maxSteps: 30 });
  state = journal.load(root);
  assert.strictEqual(state.missions.get(mission.id).state, "ready_for_human_check");
}

async function main() {
  await runToState("integrating", 4);
  await runToState("candidate", 5);
  await runToState("accepting", 6);
  console.log("Post-review restart proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
