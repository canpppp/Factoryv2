"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const releaseTrain = require("../src/release-train");
const H = require("./helpers");

async function main() {
  proveEquivalenceMismatchBlocks();
  const root = H.tmp("factoryv2-release-train-");
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
    goal: "JARVIS ship-it rollback proof",
    repo,
    missionOverrides: {
      trustDomain: "jarvis",
      acceptanceCommands: ["node -e \"const {add}=require('./src/add'); if(add(2,3)!==5) process.exit(1)\""],
      releasePolicy: {
        mergeToMain: true,
        required: true,
        shipIt: true,
        rebuildCommand: "node -e \"require('./src/add')\"",
        deployCommand: "node -e \"require('node:fs').writeFileSync('deployed.txt','yes')\"",
        smokeCommand: "node -e \"process.exit(9)\"",
        rollbackCommand: "node -e \"require('node:fs').writeFileSync('rollback.txt','done')\""
      }
    }
  });
  await c.run({ maxSteps: 30 });
  const state = journal.load(root);
  const mission = [...state.missions.values()][0];
  assert.strictEqual(mission.state, "blocked");
  assert.match(mission.blocker, /smokeCommand-failed/);
  assert.strictEqual(mission.release.steps.rolledBack, true);
  assert.strictEqual(mission.release.equivalence.ok, true);
  assert.ok(fs.existsSync(`${repo}/rollback.txt`), "rollback command did not run");
  assert.match(H.git(repo, ["show", "main:src/add.js"]), /a \+ b/, "ship-it release did not merge approved state");

  console.log("Release train proof passed");
}

function proveEquivalenceMismatchBlocks() {
  const repo = H.makeBugRepo();
  const original = H.git(repo, ["rev-parse", "HEAD"]);
  fs.writeFileSync(`${repo}/README.md`, "main drift\n");
  H.git(repo, ["add", "-A"]);
  H.git(repo, ["commit", "-q", "-m", "main drift"]);
  const result = releaseTrain.release({
    id: "mission-drift",
    repo,
    worktree: repo,
    commit: original,
    trustDomain: "jarvis",
    releasePolicy: { requireMainEquivalence: true }
  }, { shipIt: true });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /candidate-main-mismatch/);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
