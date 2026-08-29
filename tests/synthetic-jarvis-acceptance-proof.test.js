"use strict";

const assert = require("node:assert");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const { CHECKS } = require("../src/jarvis-acceptance");
const H = require("./helpers");

function fixture(overrides = {}) {
  return Object.fromEntries(CHECKS.map((c) => [c, c === "runtimeIdentity" ? "Synthetic JARVIS Candidate" : true]).concat(Object.entries(overrides)));
}

async function runWithAcceptance(syntheticJarvisAcceptance, maxSteps = 30) {
  const root = H.tmp("factoryv2-synth-jarvis-");
  const repo = H.makeBugRepo();
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  const adapter = fakeAdapter({
    scripts: {
      "MISSION mission-": [
        { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
        { type: "say", text: "fixed" }
      ],
      "REVIEW mission-": [{ type: "say", text: approve }]
    }
  });
  const c = createController({ root, adapter });
  c.enqueueGoal({
    goal: "Synthetic JARVIS acceptance proof",
    repo,
    missionOverrides: {
      candidateSpec: {
        identity: "Synthetic JARVIS Candidate",
        handshakeIdentity: "Synthetic JARVIS Candidate",
        uiRuntime: "jarvis-ui",
        agentRuntime: "jarvis-agent",
        expectedAgentRuntime: "jarvis-agent",
        dependencies: ["node"]
      },
      acceptanceCommands: ["node -e \"const {add}=require('./src/add'); if(add(2,3)!==5) process.exit(1)\""],
      syntheticJarvisAcceptance
    }
  });
  await c.run({ maxSteps });
  return journal.load(root);
}

async function main() {
  let state = await runWithAcceptance(fixture());
  let mission = [...state.missions.values()][0];
  assert.strictEqual(mission.state, "ready_for_human_check");
  assert.ok(state.events.some((e) => e.type === "jarvis.acceptance.finished" && e.result.ok));

  state = await runWithAcceptance(fixture({ emptyResponseChecks: false }), 7);
  mission = [...state.missions.values()][0];
  assert.strictEqual(mission.state, "repair");
  assert.ok(state.events.some((e) => e.type === "repair.queued" && e.findings.some((f) => /emptyResponseChecks/.test(f))));

  console.log("Synthetic JARVIS acceptance proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
