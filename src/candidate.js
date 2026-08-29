"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createCandidate(root, mission) {
  const spec = mission.candidateSpec || {};
  const manifest = {
    candidateId: `cand-${mission.id}-${Date.now()}`,
    missionId: mission.id,
    commit: mission.commit,
    worktree: mission.worktree,
    identity: spec.identity || `FactoryV2 Candidate ${mission.id}`,
    uiRuntime: spec.uiRuntime || "not-required",
    agentRuntime: spec.agentRuntime || "not-required",
    dependencyClosure: hash(spec.dependencies || []),
    launch: spec.launch || null,
    createdAt: new Date().toISOString()
  };
  const dir = path.join(root, "candidates", manifest.candidateId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { ...manifest, manifestPath: path.join(dir, "manifest.json") };
}

function launchCandidate(candidate) {
  if (!candidate.launch) return { launched: false, reason: "no-launch-required" };
  const child = spawn(candidate.launch.command, candidate.launch.args || [], {
    cwd: candidate.worktree,
    stdio: "ignore",
    detached: false
  });
  return { launched: true, pid: child.pid, child };
}

function verifyLaunch({ candidate, launch }) {
  if (!launch.launched) return { ok: true, skipped: true, reason: launch.reason };
  try {
    process.kill(launch.pid, 0);
    return { ok: true, pid: launch.pid, identity: candidate.identity };
  } catch {
    return { ok: false, reason: "candidate-pid-not-running", pid: launch.pid };
  }
}

function cleanupExactPid(launch) {
  if (!launch || !launch.launched || !launch.pid) return { ok: true, skipped: true };
  try {
    process.kill(launch.pid, "SIGTERM");
    return { ok: true, killedPid: launch.pid };
  } catch (e) {
    return { ok: false, reason: e.message, pid: launch.pid };
  }
}

module.exports = { createCandidate, launchCandidate, verifyLaunch, cleanupExactPid };
