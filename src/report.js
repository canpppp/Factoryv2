"use strict";

function missionReport(state, missionId) {
  const mission = state.missions.get(missionId);
  if (!mission) return { ok: false, reason: "mission-not-found" };
  const verification = latest(state.events, "verification.finished", missionId);
  const acceptance = latest(state.events, "acceptance.finished", missionId);
  const review = latest(state.events, "review.finished", missionId);
  const release = latest(state.events, "release.evaluated", missionId);
  const gates = verification ? verification.results : [];
  const acceptanceResults = acceptance ? acceptance.results : [];
  const machineOk = gates.every((g) => g.passed) && acceptanceResults.every((g) => g.passed)
    && (!review || review.verdict.verdict === "approve")
    && (!release || release.result.ok);
  return {
    ok: true,
    status: mission.state,
    machineOk,
    gateResults: gates.map(projectResult),
    acceptanceResults: acceptanceResults.map(projectResult),
    reviewerVerdict: review ? review.verdict.verdict : null,
    release: release ? release.result : null,
    text: renderText(mission, gates, acceptanceResults, review, release)
  };
}

function latest(events, type, missionId) {
  return [...events].reverse().find((e) => e.type === type && e.missionId === missionId) || null;
}

function projectResult(r) {
  return {
    command: r.command,
    passed: !!r.passed,
    refused: !!r.refused,
    reason: r.reason || null,
    exitCode: r.exitCode
  };
}

function renderText(mission, gates, acceptance, review, release) {
  const lines = [`${humanStatus(mission)} ${mission.id}`];
  for (const g of gates) lines.push(`${g.passed ? "PASS" : "FAIL"} gate ${g.command}`);
  for (const a of acceptance) lines.push(`${a.passed ? "PASS" : "FAIL"} acceptance ${a.command}`);
  if (review) lines.push(`REVIEW ${review.verdict.verdict}`);
  if (release) lines.push(`RELEASE ${release.result.ok ? "OK" : "BLOCKED"} ${release.result.reason}`);
  return lines.join("\n");
}

function humanStatus(mission) {
  if (mission.state === "ready_for_human_check") return "READY_FOR_HUMAN_CHECK";
  if (mission.state === "blocked") return "HUMAN_DECISION_REQUIRED";
  if (mission.state === "shipping") return "SHIPPING";
  if (mission.state === "shipped") return "SHIPPED";
  return "WORKING";
}

module.exports = { missionReport, humanStatus };
