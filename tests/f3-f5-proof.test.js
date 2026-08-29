"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const H = require("./helpers");

async function runFactoryv2SelfRelease() {
  const root = H.tmp("factoryv2-f3f5-root-");
  const repo = H.makeBugRepo();
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "candidate accepted" });
  const adapter = fakeAdapter({
    scripts: {
      "MISSION mission-": [
        { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
        { type: "write", path: "README.md", content: "FactoryV2 self-release proof\n" },
        { type: "say", text: "fixed and documented" }
      ],
      "REVIEW mission-": [{ type: "say", text: approve }]
    }
  });

  const c = createController({ root, adapter });
  c.enqueueGoal({
    goal: "Factoryv2 self-release proof",
    repo,
    missionOverrides: {
      trustDomain: "factoryv2",
      candidateSpec: {
        identity: "FactoryV2 Self Candidate",
        uiRuntime: "cli",
        agentRuntime: "fake-agent",
        dependencies: ["node", "git"],
        launch: { command: process.execPath, args: ["-e", "setTimeout(()=>{}, 30000)"] }
      },
      acceptanceCommands: ["node -e \"const {add}=require('./src/add'); if(add(2,3)!==5) process.exit(1)\""],
      releasePolicy: { mergeToMain: true, required: true }
    }
  });
  await c.run({ maxSteps: 30 });

  const state = journal.load(root);
  const mission = [...state.missions.values()][0];
  assert.strictEqual(mission.state, "ready_for_human_check");
  assert.ok(mission.candidate && mission.candidate.manifestPath);
  assert.ok(fs.existsSync(mission.candidate.manifestPath), "candidate manifest missing");
  assert.strictEqual(mission.candidate.verified.ok, true);
  assert.strictEqual(mission.candidate.cleanup.ok, true);
  assert.strictEqual(mission.release.mergedToMain, true);
  const receipt = state.events.find((e) => e.type === "receipt" && e.missionId === mission.id);
  assert.match(receipt.summary, /acceptance=\[PASS node -e/, "receipt did not include actual acceptance result");
  assert.match(H.git(repo, ["show", "main:src/add.js"]), /a \+ b/, "Factoryv2 self-release did not merge main");
}

async function runJarvisReleaseRefusal() {
  const root = H.tmp("factoryv2-f5-jarvis-root-");
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
    goal: "JARVIS release must wait for Ship it",
    repo,
    missionOverrides: {
      trustDomain: "jarvis",
      acceptanceCommands: ["node -e \"const {add}=require('./src/add'); if(add(2,3)!==5) process.exit(1)\""],
      releasePolicy: { mergeToMain: true, required: true, shipIt: false }
    }
  });
  await c.run({ maxSteps: 30 });
  const state = journal.load(root);
  const mission = [...state.missions.values()][0];
  assert.strictEqual(mission.state, "blocked");
  assert.match(mission.blocker, /jarvis-release-needs-human-ship-it/);
  assert.match(H.git(repo, ["show", "main:src/add.js"]), /a - b/, "JARVIS release merged without Ship it");
}

async function main() {
  await runFactoryv2SelfRelease();
  await runJarvisReleaseRefusal();
  console.log("F3/F4/F5 proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
