"use strict";

const assert = require("node:assert");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const envelope = require("../src/envelope");
const H = require("./helpers");

async function main() {
  const root = H.tmp("factoryv2-f2-root-");
  const repo = H.makeBugRepo();
  const c = createController({ root, adapter: fakeAdapter({}) });

  c.enqueueGoal({ goal: "Update credential handling boundary docs", repo });
  let state = journal.load(root);
  const blocked = [...state.goals.values()][0];
  assert.strictEqual(blocked.state, "blocked");
  assert.match(blocked.updatedAt || state.events.find((e) => e.type === "goal.state").at, /T/);

  const root2 = H.tmp("factoryv2-f2-root-");
  const c2 = createController({ root: root2, adapter: fakeAdapter({}) });
  c2.enqueueGoal({
    goal: "Update credential handling boundary docs",
    repo,
    missionOverrides: { allowedAuthorityClasses: ["credential-handling"] }
  });
  state = journal.load(root2);
  const allowed = [...state.goals.values()][0];
  assert.strictEqual(allowed.state, "queued");

  const env = envelope.createEnvelope({ goal: "same contract", repo, trustDomain: "jarvis" });
  assert.strictEqual(envelope.administrativeUpdateAllowed({
    beforeHash: env.boundContractHash,
    afterHash: env.boundContractHash,
    field: "architectApproval.scopeHash"
  }).ok, true);
  assert.strictEqual(envelope.administrativeUpdateAllowed({
    beforeHash: env.boundContractHash,
    afterHash: "changed",
    field: "architectApproval.scopeHash"
  }).ok, false);

  console.log("F2 envelope proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
