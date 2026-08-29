"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { spawnSync } = require("node:child_process");

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
    runtimeHash: hash({ uiRuntime: spec.uiRuntime || "not-required", agentRuntime: spec.agentRuntime || "not-required" }),
    preflight: preflightDependencies(mission.worktree, spec.dependencies || []),
    pairing: verifyPairing(spec),
    launch: spec.launch || null,
    createdAt: new Date().toISOString()
  };
  const dir = path.join(root, "candidates", manifest.candidateId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { ...manifest, manifestPath: path.join(dir, "manifest.json") };
}

function preflightDependencies(worktree, dependencies) {
  const missing = [];
  for (const dep of dependencies) {
    if (dep === "node" || dep === "git") {
      const r = spawnSync("/bin/bash", ["-lc", `command -v ${dep}`], { encoding: "utf8" });
      if (r.status !== 0) missing.push(dep);
      continue;
    }
    try {
      require.resolve(dep, { paths: [worktree] });
    } catch {
      missing.push(dep);
    }
  }
  return { ok: missing.length === 0, missing };
}

function verifyPairing(spec) {
  if (spec.expectedAgentRuntime && spec.agentRuntime !== spec.expectedAgentRuntime) {
    return { ok: false, reason: "agent-runtime-mismatch", expected: spec.expectedAgentRuntime, actual: spec.agentRuntime };
  }
  if (spec.expectedUiRuntime && spec.uiRuntime !== spec.expectedUiRuntime) {
    return { ok: false, reason: "ui-runtime-mismatch", expected: spec.expectedUiRuntime, actual: spec.uiRuntime };
  }
  if (spec.handshakeIdentity && spec.identity !== spec.handshakeIdentity) {
    return { ok: false, reason: "handshake-identity-mismatch", expected: spec.handshakeIdentity, actual: spec.identity };
  }
  return { ok: true };
}

function launchCandidate(candidate) {
  if (!candidate.launch) return { launched: false, reason: "no-launch-required" };
  if (!candidate.preflight.ok) return { launched: false, reason: "dependency-preflight-failed", missing: candidate.preflight.missing };
  if (!candidate.pairing.ok) return { launched: false, reason: candidate.pairing.reason };
  const child = spawn(candidate.launch.command, candidate.launch.args || [], {
    cwd: candidate.worktree,
    stdio: "ignore",
    detached: false
  });
  return { launched: true, pid: child.pid, child };
}

function verifyLaunch({ candidate, launch }) {
  if (!candidate.preflight.ok) return { ok: false, reason: "dependency-preflight-failed", missing: candidate.preflight.missing };
  if (!candidate.pairing.ok) return { ok: false, reason: candidate.pairing.reason, expected: candidate.pairing.expected, actual: candidate.pairing.actual };
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

module.exports = { createCandidate, launchCandidate, verifyLaunch, cleanupExactPid, preflightDependencies, verifyPairing };
