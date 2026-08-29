"use strict";

const assert = require("node:assert");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const H = require("./helpers");

async function main() {
  const root = H.tmp("factoryv2-endurance-");
  const repo = H.makeBugRepo();
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "ok" });
  const reject = JSON.stringify({ verdict: "reject", findings: ["record endurance evidence in README"], summary: "needs evidence" });
  let alphaTurns = 0;
  const adapter = fakeAdapter({
    scripts: {
      "MISSION mission-endurance-alpha": () => {
        alphaTurns++;
        if (alphaTurns === 1) return [
          { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
          { type: "crash", message: "synthetic endurance interruption" }
        ];
        if (alphaTurns === 2) return [
          { type: "write", path: "src/add.js", content: "exports.add = (a, b) => a + b;\n" },
          { type: "say", text: "alpha implemented after restart" }
        ];
        return [
          { type: "write", path: "README.md", content: "Endurance evidence recorded after reviewer rejection.\n" },
          { type: "say", text: "alpha repaired" }
        ];
      },
      "MISSION mission-endurance-beta": [
        { type: "write", path: "docs/beta.md", content: "beta candidate mission\n" },
        { type: "say", text: "beta implemented" }
      ],
      "REVIEW mission-endurance-alpha": ({ round }) => [{ type: "say", text: round === 1 ? reject : approve }],
      "REVIEW mission-endurance-beta": [{ type: "say", text: approve }]
    }
  });

  const c1 = createController({ root, adapter });
  c1.enqueueGoal({
    goal: "Endurance synthetic Factory goal",
    repo,
    missionOverrides: {
      missions: [
        {
          id: "mission-endurance-alpha",
          title: "Endurance alpha",
          branch: "factory/endurance-alpha",
          ownedFiles: ["src/**", "README.md"],
          verifyCommands: ["npm test"],
          acceptanceCommands: ["npm test"]
        },
        {
          id: "mission-endurance-beta",
          title: "Endurance beta",
          branch: "factory/endurance-beta",
          ownedFiles: ["docs/**"],
          verifyCommands: ["test -f docs/beta.md"],
          acceptanceCommands: ["test -f docs/beta.md"],
          dependsOn: ["mission-endurance-alpha"],
          candidateSpec: {
            identity: "Endurance Candidate",
            handshakeIdentity: "Endurance Candidate",
            uiRuntime: "fake-ui",
            agentRuntime: "fake-agent",
            expectedAgentRuntime: "fake-agent",
            dependencies: ["node"],
            launch: { command: process.execPath, args: ["-e", "setTimeout(()=>{}, 30000)"] }
          }
        }
      ]
    }
  });

  const first = await c1.run({ maxSteps: 5 });
  assert.match(first.summary, /interrupted/);

  const c2 = createController({ root, adapter });
  await c2.run({ maxSteps: 80 });

  const state = journal.load(root);
  const alpha = state.missions.get("mission-endurance-alpha");
  const beta = state.missions.get("mission-endurance-beta");
  assert.strictEqual(alpha.state, "ready_for_human_check");
  assert.strictEqual(beta.state, "ready_for_human_check");
  assert.strictEqual(alpha.repairRounds, 1);
  assert.ok(beta.candidate && beta.candidate.verified.ok);
  assert.ok(state.events.some((e) => e.type === "worker.interrupted" && e.missionId === alpha.id));
  assert.ok(state.events.some((e) => e.type === "review.finished" && e.missionId === alpha.id && e.verdict.verdict === "reject"));
  assert.ok(state.events.some((e) => e.type === "candidate.verified" && e.missionId === beta.id));
  assert.ok(state.receipts.filter((e) => e.status === "READY_FOR_HUMAN_CHECK").length >= 2);

  console.log("Endurance proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
