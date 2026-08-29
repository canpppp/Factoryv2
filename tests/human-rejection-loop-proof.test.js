"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const H = require("./helpers");

function cli(root, args) {
  return spawnSync(process.execPath, [path.join(__dirname, "../bin/factoryv2.js"), "--root", root, ...args], { encoding: "utf8" });
}

async function main() {
  const root = H.tmp("factoryv2-human-reject-");
  const repo = H.makeBugRepo();
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  let workerTurns = 0;
  const adapter = fakeAdapter({
    scripts: {
      "MISSION mission-": () => {
        workerTurns++;
        if (workerTurns === 1) return [
          { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
          { type: "say", text: "fixed add" }
        ];
        return [
          { type: "write", path: "README.md", content: "Feedback addressed: UGC page clarity and shorter JARVIS responses are captured as bounded follow-up work.\n" },
          { type: "say", text: "addressed human feedback" }
        ];
      },
      "REVIEW mission-": [{ type: "say", text: approve }]
    }
  });
  const c = createController({ root, adapter });
  c.enqueueGoal({
    goal: "Simulate JARVIS candidate feedback repair",
    repo,
    missionOverrides: {
      acceptanceCommands: ["node -e \"const {add}=require('./src/add'); if(add(2,3)!==5) process.exit(1)\""]
    }
  });
  await c.run({ maxSteps: 30 });
  let state = journal.load(root);
  const mission = [...state.missions.values()][0];
  assert.strictEqual(mission.state, "ready_for_human_check");

  const rejected = cli(root, ["reject", mission.id, "The UGC page is confusing and JARVIS talks too much."]);
  assert.strictEqual(rejected.status, 0);
  assert.match(rejected.stdout, /repair queued/);

  await c.run({ maxSteps: 30 });
  state = journal.load(root);
  const repaired = state.missions.get(mission.id);
  assert.strictEqual(repaired.state, "ready_for_human_check");
  assert.ok(state.events.some((e) => e.type === "human.rejected" && /UGC page/.test(e.feedback)));
  assert.ok(state.events.some((e) => e.type === "repair.queued" && e.findings.some((f) => /human feedback/.test(f))));
  assert.ok(workerTurns >= 2, "feedback did not trigger a repair worker turn");
  assert.match(H.git(repaired.worktree, ["show", "HEAD:README.md"]), /Feedback addressed/);

  console.log("Human rejection loop proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
