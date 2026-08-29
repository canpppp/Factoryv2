"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function gitSha(repo, ref = "HEAD") {
  const r = spawnSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function fileHash(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function directoryHash(dir) {
  const files = listFiles(dir);
  const payload = files.map((file) => `${path.relative(dir, file)}\0${fileHash(file)}`).join("\n");
  return sha256(payload);
}

function listFiles(dir) {
  let out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) out = out.concat(listFiles(full));
      else if (stat.isFile()) out.push(full);
    }
  } catch {
    return [];
  }
  return out.sort();
}

function sourceIdentity(worktree) {
  return {
    headSha: gitSha(worktree, "HEAD"),
    mainSha: gitSha(worktree, "main"),
    treeHash: directoryHash(worktree)
  };
}

function runtimeIdentity(spec = {}, worktree = process.cwd()) {
  const uiPath = spec.uiRuntimePath ? path.resolve(worktree, spec.uiRuntimePath) : null;
  const agentPath = spec.agentRuntimePath ? path.resolve(worktree, spec.agentRuntimePath) : null;
  return {
    uiRuntime: spec.uiRuntime || "not-required",
    agentRuntime: spec.agentRuntime || "not-required",
    uiRuntimeHash: uiPath ? fileHash(uiPath) : hashLabel(spec.uiRuntime || "not-required"),
    agentRuntimeHash: agentPath ? fileHash(agentPath) : hashLabel(spec.agentRuntime || "not-required")
  };
}

function hashLabel(label) {
  return sha256(String(label));
}

function listenerOwnership(spec = {}) {
  if (!spec.listener) return { ok: true, skipped: true };
  const expected = spec.listener.expectedOwner;
  const actual = spec.listener.actualOwner;
  if (expected && actual && expected !== actual) {
    return { ok: false, reason: "listener-owner-mismatch", expected, actual };
  }
  return { ok: true, owner: actual || expected || null };
}

function candidateMainEquivalence(mission) {
  if (!mission.releasePolicy || !mission.releasePolicy.requireMainEquivalence) {
    return { ok: true, skipped: true };
  }
  const candidateSha = mission.commit || gitSha(mission.worktree, "HEAD");
  const mainSha = gitSha(mission.repo, "main");
  const candidateTree = gitSha(mission.worktree, `${candidateSha}^{tree}`);
  const mainTree = gitSha(mission.repo, "main^{tree}");
  return {
    ok: candidateTree === mainTree,
    candidateSha,
    mainSha,
    candidateTree,
    mainTree,
    reason: candidateTree === mainTree ? null : "candidate-main-mismatch"
  };
}

function verifyManifest(manifest, mission) {
  const checks = [
    manifest.preflight && manifest.preflight.ok ? ok("dependency-preflight") : fail("dependency-preflight", "dependency-preflight-failed"),
    manifest.pairing && manifest.pairing.ok ? ok("runtime-pairing") : fail("runtime-pairing", manifest.pairing && manifest.pairing.reason || "runtime-pairing-failed"),
    manifest.launchServices && manifest.launchServices.ok ? ok("launchservices") : fail("launchservices", manifest.launchServices && manifest.launchServices.reason || "launchservices-failed"),
    manifest.listenerOwnership && manifest.listenerOwnership.ok ? ok("listener-ownership") : fail("listener-ownership", manifest.listenerOwnership && manifest.listenerOwnership.reason || "listener-ownership-failed"),
    manifest.mainEquivalence && manifest.mainEquivalence.ok ? ok("main-equivalence") : fail("main-equivalence", manifest.mainEquivalence && manifest.mainEquivalence.reason || "main-equivalence-failed")
  ];
  if (mission && mission.candidateSpec && mission.candidateSpec.handshakeIdentity) {
    checks.push(manifest.identity === mission.candidateSpec.handshakeIdentity
      ? ok("handshake-identity")
      : fail("handshake-identity", "handshake-identity-mismatch"));
  }
  return { ok: checks.every((x) => x.ok), checks };
}

function ok(name) {
  return { name, ok: true };
}

function fail(name, reason) {
  return { name, ok: false, reason };
}

module.exports = {
  sha256,
  gitSha,
  fileHash,
  directoryHash,
  sourceIdentity,
  runtimeIdentity,
  listenerOwnership,
  candidateMainEquivalence,
  verifyManifest
};
