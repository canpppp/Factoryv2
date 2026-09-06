"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const journal = require("../src/journal");
const { createMissionRequests, load } = require("../src/mission-requests");
const H = require("./helpers");
async function main() {
  const root = H.tmp("factory-owner-parser-");
  journal.append(root, { type: "mission.created", missionId: "m", mission: {} });
  let calls = 0;
  const requests = createMissionRequests({ root, owner: () => ({ assertOwned() {}, record: { generation: "g" } }),
    controller: () => ({ run: async () => { calls++; return { ok: true, summary: "bounded" }; } }) });
  const params = { requestId: "r", missionId: "m", maxSteps: 1 };
  assert.deepEqual(requests.admit(params), requests.admit(params));
  assert.throws(() => requests.admit({ ...params, maxSteps: 2 }), { code: "REQUEST_CONFLICT" });
  for (const extra of [{ rolePolicies: {} }, { maxSteps: 0 }, { maxSteps: 101 }, { requestId: "../bad" }]) assert.throws(() => requests.admit({ ...params, ...extra }));
  assert.throws(() => requests.admit({ ...params, requestId: "other" }), { code: "MISSION_REQUEST_BLOCKED" });
  await requests.runNext();
  assert.equal(calls, 1);
  const result = requests.result({ requestId: "r" });
  assert.equal(result.status, "finished"); assert.equal(result.outcome.objectiveCompleted, false);
  requests.admit({ ...params, requestId: "interrupted" });
  journal.append(root, { type: "owner.request.started", requestId: "interrupted", patch: { status: "started", attemptId: "a" } });
  requests.reconcile();
  assert.equal(load(root).requests.get("interrupted").status, "blocked");
  assert.deepEqual(requests.result({ requestId: "r" }), result);
  assert.throws(() => requests.admit({ ...params, requestId: "retry" }), { code: "MISSION_REQUEST_BLOCKED" });
  fs.appendFileSync(path.join(root, "events.jsonl"), "{");
  assert.throws(() => requests.result({ requestId: "r" }), { code: "JOURNAL_UNCERTAIN" });
  console.log("OWNER admission, exact results, narrowing and uncertain replay parser PASS (not process proof)");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
