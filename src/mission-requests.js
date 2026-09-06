"use strict";

const fs = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const journal = require("./journal");
const { fail } = require("./execution-owner");
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);

function load(root) {
  const file = journal.paths(root).journal;
  try { fs.accessSync(file, fs.constants.R_OK); } catch (e) { if (e.code !== "ENOENT") fail("JOURNAL_UNREADABLE"); }
  const state = journal.load(root);
  if (!state.ok || state.truncated) fail("JOURNAL_UNCERTAIN");
  const requests = new Map();
  for (const event of state.events) {
    if (event.type === "owner.request.admitted") requests.set(event.request.id, structuredClone(event.request));
    if (["owner.request.started", "owner.request.finished", "owner.request.blocked"].includes(event.type)) {
      const request = requests.get(event.requestId);
      if (!request) fail("JOURNAL_UNCERTAIN");
      Object.assign(request, event.patch);
    }
  }
  return { ...state, requests };
}
function createMissionRequests({ root, controller, owner }) {
  function update(request, status, fields = {}) {
    journal.append(root, { type: `owner.request.${status}`, requestId: request.id, missionId: request.missionId, patch: { status, ...fields } });
  }
  function result({ requestId, ...rest } = {}) {
    owner().assertOwned();
    if (!id(requestId) || Object.keys(rest).length) fail("REQUEST_INVALID");
    const request = load(root).requests.get(requestId);
    if (!request) fail("REQUEST_NOT_FOUND");
    return request;
  }
  function admit(params = {}) {
    owner().assertOwned();
    const { requestId, missionId, maxSteps = 1, ...rest } = params;
    if (!id(requestId) || !id(missionId) || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100 || Object.keys(rest).length) fail("REQUEST_INVALID");
    const digest = createHash("sha256").update(JSON.stringify({ missionId, maxSteps })).digest("hex");
    const state = load(root), previous = state.requests.get(requestId);
    if (previous) { if (previous.digest !== digest) fail("REQUEST_CONFLICT"); return previous; }
    const mission = state.missions.get(missionId);
    if (!mission) fail("MISSION_NOT_FOUND");
    if ([...state.requests.values()].some((r) => r.missionId === missionId && r.status !== "finished")) fail("MISSION_REQUEST_BLOCKED");
    if (Object.values(mission.roleSessions || {}).some((r) => r.status !== "settled")) fail("RECONCILIATION_REQUIRED");
    const request = { id: requestId, missionId, maxSteps, digest, status: "admitted", generation: owner().record.generation, admittedAt: new Date().toISOString() };
    journal.append(root, { type: "owner.request.admitted", request });
    return request;
  }
  function reconcile() {
    const state = load(root);
    for (const request of state.requests.values()) {
      if (request.status === "started") update(request, "blocked", { code: "RECONCILIATION_REQUIRED", externalEffects: "UNKNOWN" });
    }
    // Missing terminal channel evidence cannot authorize resume after owner loss.
    const activeChannels = new Map();
    for (const event of state.events) {
      if (event.type === "worker.attempt.started" && event.channelId) activeChannels.set(event.channelId, event.jobId);
      if (event.type === "worker.attempt.finished" && activeChannels.get(event.channelId) === event.jobId && event.receipt?.metadata?.ownedRunSettled === true) activeChannels.delete(event.channelId);
    }
    for (const [channelId, jobId] of activeChannels) {
      if (!state.channels.get(channelId)?.workerBlocked) journal.append(root, { type: "channel.updated", channelId,
        patch: { workerBlocked: { code: "RECONCILIATION_REQUIRED", jobId, externalEffects: "UNKNOWN" } } });
    }
  }
  async function runNext() {
    owner().assertOwned();
    const state = load(root);
    const request = [...state.requests.values()].find((r) => r.status === "admitted");
    if (!request) return { ok: true, summary: "no admitted mission requests" };
    const attemptId = randomUUID();
    update(request, "started", { attemptId, executionGeneration: owner().record.generation });
    let execution;
    try { execution = await controller().run({ missionId: request.missionId, maxSteps: request.maxSteps }); }
    catch { update(request, "blocked", { code: "RECONCILIATION_REQUIRED", externalEffects: "UNKNOWN" }); return { ok: false, code: "RECONCILIATION_REQUIRED" }; }
    owner().assertOwned();
    const mission = load(root).missions.get(request.missionId);
    const uncertain = Object.values(mission?.roleSessions || {}).some((r) => r.status !== "settled");
    const outcome = { execution, missionState: mission?.state || null, roleSessions: mission?.roleSessions || {}, objectiveCompleted: false };
    update(request, uncertain ? "blocked" : "finished", { outcome, ...(uncertain ? { code: "RECONCILIATION_REQUIRED", externalEffects: "UNKNOWN" } : {}) });
    return execution;
  }
  return { admit, result, reconcile, runNext };
}
module.exports = { createMissionRequests, load };
