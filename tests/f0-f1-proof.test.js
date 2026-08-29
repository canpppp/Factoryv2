"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const H = require("./helpers");

async function main() {
  const root = H.tmp("factoryv2-root-");
  const repo = H.makeBugRepo();
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  const reject = JSON.stringify({ verdict: "reject", findings: ["README must record the fix evidence"], summary: "missing evidence" });
  let missionId = null;

  const adapter = fakeAdapter({
    scripts: {
      "MISSION mission-": ({ round }) => {
        if (round === 1) return [
          { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
          { type: "crash", message: "simulated worker interruption" }
        ];
        if (round === 2) return [
          { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
          { type: "say", text: "fixed add implementation after restart" }
        ];
        return [
          { type: "write", path: "README.md", content: "Bug repo\n\nFactory evidence: add(2, 3) now returns 5 and npm test passes.\n" },
          { type: "say", text: "added reviewer-requested evidence" }
        ];
      },
      "REVIEW mission-": ({ round }) => [
        { type: "say", text: round === 1 ? reject : approve }
      ]
    }
  });

  const c1 = createController({ root, adapter });
  c1.enqueueGoal({ goal: "Fix the controlled add bug and prepare it for human check", repo });
  const interrupted = await c1.run({ maxSteps: 3 });
  assert.match(interrupted.summary, /interrupted/);

  let state = journal.load(root);
  missionId = [...state.missions.keys()][0];
  let mission = state.missions.get(missionId);
  assert.ok(mission.workerThreadId, "worker thread id was not persisted before interruption");
  const workerThread = mission.workerThreadId;

  const c2 = createController({ root, adapter });
  const finished = await c2.run({ maxSteps: 20 });
  assert.strictEqual(finished.ok, true);

  state = journal.load(root);
  mission = state.missions.get(missionId);
  assert.strictEqual(mission.state, "ready_for_human_check");
  assert.strictEqual(mission.workerThreadId, workerThread, "repair did not resume the same worker thread");
  assert.ok(mission.reviewerThreadId, "reviewer thread missing");
  assert.notStrictEqual(mission.reviewerThreadId, mission.workerThreadId, "reviewer was not independent");
  assert.strictEqual(mission.repairRounds, 1, "reviewer rejection did not create exactly one repair round");
  assert.ok(adapter.turnsOf(workerThread) >= 3, "same worker did not receive restart plus repair turns");
  assert.ok(state.events.some((e) => e.type === "review.finished" && e.verdict.verdict === "reject"), "reviewer rejection was not journaled");
  assert.ok(state.events.some((e) => e.type === "receipt" && e.status === "READY_FOR_HUMAN_CHECK"), "human-check receipt missing");
  assert.ok(state.events.every((e) => e.type !== "merge.performed" && e.type !== "deploy.performed"), "Factory merged or deployed");

  const mainValue = H.git(repo, ["show", "main:src/add.js"]);
  assert.match(mainValue, /a - b/, "main changed; no-merge proof failed");
  const branchValue = H.git(path.join(journal.paths(root).worktrees, missionId), ["show", "HEAD:src/add.js"]);
  assert.match(branchValue, /a \+ b/, "candidate branch did not contain the fix");

  console.log("F0/F1 proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
