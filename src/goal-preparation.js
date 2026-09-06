"use strict";

const journal = require("./journal");
const envelope = require("./envelope");
const { planGoal } = require("./controller");
const { load } = require("./mission-requests");
const { fail } = require("./execution-owner");
const validId = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const validKey = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);

function createGoalPreparation({ root, owner }) {
  function block(request, code = "PREPARATION_UNCERTAIN") {
    journal.append(root, { type: "goal.preparation.blocked", requestId: request.id, patch: { status: "blocked", code } });
  }
  function reconcile() {
    for (const request of load(root).preparations.values()) if (request.status === "preparing") block(request);
  }
  function prepare({ requestId, goalId, ...rest } = {}) {
    owner().assertOwned();
    if (!validKey(requestId) || !validId(goalId) || Object.keys(rest).length) fail("REQUEST_INVALID");
    const state = load(root);
    const digest = envelope.hash({ kind: "goal.prepare", goalId });
    if (state.requests.has(requestId)) fail("REQUEST_CONFLICT");
    const previous = state.preparations.get(requestId);
    if (previous) {
      if (previous.digest !== digest) fail("REQUEST_CONFLICT");
      return previous;
    }
    if ([...state.preparations.values()].some((r) => r.goalId === goalId)) fail("GOAL_ALREADY_PREPARED");
    const goal = state.goals.get(goalId);
    if (!goal) fail("GOAL_NOT_FOUND");
    if (goal.state !== "queued") fail("GOAL_NOT_PREPARABLE");
    if (!goal.envelope || !envelope.validateEnvelope(goal.envelope).ok) fail("ENVELOPE_DENIED");
    const expected = envelope.createEnvelope({ ...goal.envelope, goal: goal.text, repo: goal.repo });
    if (expected.boundContractHash !== goal.envelope.boundContractHash || expected.id !== goal.envelope.id) fail("ENVELOPE_DENIED");
    if (goal.missionOverrides?.missions?.length > 32) fail("PREPARATION_LIMIT");
    const plan = planGoal(goal);
    if (plan.length > 32 || Buffer.byteLength(JSON.stringify(plan)) > 256 * 1024) fail("PREPARATION_LIMIT");
    const missionIds = plan.map((p) => p.missionId);
    const reserved = new Set([...state.preparations.values()].flatMap((r) => r.missionIds));
    if (missionIds.some((id) => !validId(id))) fail("MISSION_ID_INVALID");
    if (new Set(missionIds).size !== missionIds.length || missionIds.some((id) => state.missions.has(id) || reserved.has(id))) fail("MISSION_ID_COLLISION");
    for (const { mission } of plan) {
      if (mission.goalId !== goalId || mission.repo !== goal.repo || mission.trustDomain !== goal.envelope.trustDomain
        || envelope.hash(mission.envelope) !== envelope.hash(goal.envelope) || Object.hasOwn(mission, "preparationRequestId")) fail("ENVELOPE_DENIED");
    }
    const request = { id: requestId, goalId, digest, planDigest: envelope.hash(plan), missionIds, status: "preparing",
      generation: owner().record.generation, executionStarted: false, objectiveCompleted: false };
    journal.append(root, { type: "goal.preparation.started", request });
    try {
      journal.append(root, { type: "architect.started", goalId, preparationRequestId: requestId });
      for (const { missionId, mission } of plan) {
        owner().assertOwned();
        journal.append(root, { type: "mission.created", goalId, missionId, mission, preparationRequestId: requestId });
      }
      owner().assertOwned();
      journal.append(root, { type: "goal.preparation.finished", requestId, patch: { status: "prepared" } });
    } catch {
      owner().assertOwned();
      block(request);
    }
    return load(root).preparations.get(requestId);
  }
  return { prepare, reconcile };
}
module.exports = { createGoalPreparation };
