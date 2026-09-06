"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createController, planGoal } = require("../src/controller");
const { createGoalPreparation } = require("../src/goal-preparation");
const { createMissionRequests } = require("../src/mission-requests");
const journal = require("../src/journal");
const H = require("./helpers");

async function main() {
  const root = H.tmp("fg-parser-"), repo = H.makeBugRepo();
  const controller = createController({ root });
  const owner = () => ({ assertOwned() {}, record: { generation: "test" } });
  const preparation = createGoalPreparation({ root, owner });
  const requests = createMissionRequests({ root, owner, controller: () => controller });
  const templates = [{ id: "first", title: "preserve", maxRepairRounds: 0, tokenBudget: 1234, jobPack: { hash: "pack" }, priming: { ref: "prime" }, effects: ["read"], verifyCommands: ["node test.js"] }, { id: "second", ownedFiles: ["docs/**"], dependsOn: ["first"] }];
  const goal = controller.enqueueGoal({ goal: "metadata preparation", repo, missionOverrides: { missions: templates } });
  const unrelated = controller.enqueueGoal({ goal: "unrelated work", repo });
  const before = journal.load(root);
  const expected = planGoal(before.goals.get(goal.id));
  const p = { goalId: goal.id, requestId: "prep" };
  const result = preparation.prepare(p);
  assert.equal(result.status, "prepared");
  assert.equal(result.objectiveCompleted, false);
  assert.equal(result.executionStarted, false);
  assert.deepEqual(result.missionIds, ["first", "second"]);
  assert.deepEqual(preparation.prepare(p), result);
  assert.deepEqual(requests.result({ requestId: "prep" }), result);
  assert.throws(() => preparation.prepare({ ...p, goalId: unrelated.id }), { code: "REQUEST_CONFLICT" });
  assert.throws(() => preparation.prepare({ ...p, requestId: "other" }), { code: "GOAL_ALREADY_PREPARED" });
  assert.throws(() => requests.admit({ requestId: "prep", missionId: "first" }), { code: "REQUEST_CONFLICT" });
  requests.admit({ requestId: "run-key", missionId: "first" });
  assert.throws(() => preparation.prepare({ ...p, requestId: "run-key" }), { code: "REQUEST_CONFLICT" });
  const after = journal.load(root);
  assert.equal(after.goals.get(unrelated.id).state, "queued");
  assert.equal(after.events.find((e) => e.type === "goal.preparation.started").request.status, "preparing");
  for (const item of expected) {
    const created = after.events.find((e) => e.type === "mission.created" && e.missionId === item.missionId);
    assert.deepEqual(created.mission, item.mission);
    for (const [key, value] of Object.entries(templates.find((t) => t.id === item.missionId))) assert.deepEqual(created.mission[key], value);
    assert.deepEqual(created.mission.envelope, before.goals.get(goal.id).envelope);
  }
  assert.equal(after.events.some((e) => /worker.attempt|mission.role.session|integration|candidate|release/.test(e.type)), false);
  assert.deepEqual(fs.readdirSync(journal.paths(root).worktrees), []);
  for (const denied of [{ env: {} }, { rolePolicies: {} }, { missionOverrides: {} }, { tools: [] }, { requestId: "x".repeat(129) }]) {
    assert.throws(() => preparation.prepare({ ...p, ...denied }), { code: "REQUEST_INVALID" });
  }
  assert.throws(() => preparation.prepare({ goalId: "missing", requestId: "unknown" }), { code: "GOAL_NOT_FOUND" });
  const blocked = controller.enqueueGoal({ goal: "Update credential handling boundary docs", repo });
  assert.throws(() => preparation.prepare({ goalId: blocked.id, requestId: "blocked" }), { code: "GOAL_NOT_PREPARABLE" });
  const collision = controller.enqueueGoal({ goal: "collision", repo, missionOverrides: { id: "first" } });
  assert.throws(() => preparation.prepare({ goalId: collision.id, requestId: "collision" }), { code: "MISSION_ID_COLLISION" });
  const duplicate = controller.enqueueGoal({ goal: "duplicate IDs", repo, missionOverrides: { missions: [{ id: "repeat" }, { id: "repeat" }] } });
  assert.throws(() => preparation.prepare({ goalId: duplicate.id, requestId: "duplicate" }), { code: "MISSION_ID_COLLISION" });
  const large = controller.enqueueGoal({ goal: "bounded plan", repo, missionOverrides: { missions: Array.from({ length: 33 }, (_, i) => ({ id: "m" + i })) } });
  assert.throws(() => preparation.prepare({ goalId: large.id, requestId: "large" }), { code: "PREPARATION_LIMIT" });
  const badEnvelope = controller.enqueueGoal({ goal: "invalid binding", repo, missionOverrides: { repo: "/outside" } });
  assert.throws(() => preparation.prepare({ goalId: badEnvelope.id, requestId: "bad-envelope" }), { code: "ENVELOPE_DENIED" });

  const interrupted = controller.enqueueGoal({ goal: "interrupt multi mission", repo, missionOverrides: { missions: [{ id: "partial" }, { id: "reserved" }] } });
  const append = journal.append;
  journal.append = (...args) => {
    const event = append(...args);
    if (event.type === "mission.created" && event.missionId === "partial") {
      assert.equal(journal.load(root).missions.get("partial").state, "preparing");
      assert.throws(() => requests.admit({ requestId: "premature", missionId: "partial" }), { code: "PREPARATION_BLOCKED" });
      throw new Error("synthetic interruption");
    }
    return event;
  };
  let partial;
  try { partial = preparation.prepare({ goalId: interrupted.id, requestId: "partial-prep" }); } finally { journal.append = append; }
  assert.equal(partial.status, "blocked");
  assert.equal((await controller.step({ missionId: "partial" })).code, "PREPARATION_BLOCKED");
  assert.throws(() => requests.admit({ requestId: "retry-partial", missionId: "partial" }), { code: "PREPARATION_BLOCKED" });
  const steal = controller.enqueueGoal({ goal: "reserved collision", repo, missionOverrides: { id: "reserved" } });
  assert.throws(() => preparation.prepare({ goalId: steal.id, requestId: "steal" }), { code: "MISSION_ID_COLLISION" });
  assert.equal(journal.load(root).missions.has("reserved"), false);
  console.log("GOAL preparation parser/template/envelope/identity/quarantine contracts PASS (no process proof)");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
