"use strict";

const assert = require("node:assert");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const H = require("./helpers");

async function runCandidate(candidateSpec) {
  const root = H.tmp("factoryv2-candidate-");
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
    goal: "Candidate isolation proof",
    repo,
    missionOverrides: {
      candidateSpec,
      acceptanceCommands: ["node -e \"const {add}=require('./src/add'); if(add(2,3)!==5) process.exit(1)\""]
    }
  });
  await c.run({ maxSteps: 30 });
  return [...journal.load(root).missions.values()][0];
}

async function main() {
  const missingDependency = await runCandidate({
    identity: "Candidate With Missing Dependency",
    uiRuntime: "fake-ui",
    agentRuntime: "fake-agent",
    dependencies: ["@anthropic-ai/sdk"],
    launch: { command: process.execPath, args: ["-e", "setTimeout(()=>{}, 30000)"] }
  });
  assert.strictEqual(missingDependency.state, "blocked");
  assert.match(missingDependency.blocker, /dependency-preflight-failed/);
  assert.deepStrictEqual(missingDependency.candidate.verified.missing, ["@anthropic-ai/sdk"]);

  const mismatch = await runCandidate({
    identity: "Candidate UI",
    handshakeIdentity: "Candidate UI",
    uiRuntime: "candidate-ui",
    agentRuntime: "stable-agent",
    expectedAgentRuntime: "candidate-agent",
    dependencies: ["node"],
    launch: { command: process.execPath, args: ["-e", "setTimeout(()=>{}, 30000)"] }
  });
  assert.strictEqual(mismatch.state, "blocked");
  assert.match(mismatch.blocker, /agent-runtime-mismatch/);
  assert.strictEqual(mismatch.candidate.launch.launched, false);

  console.log("Candidate isolation proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
