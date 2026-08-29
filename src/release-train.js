"use strict";

const policy = require("./policy");
const git = require("./git");
const { spawnSync } = require("node:child_process");

function integrate(mission) {
  return {
    mode: mission.integrationMode || "candidate-branch",
    branch: mission.branch,
    commit: mission.commit,
    mergedToMain: false
  };
}

function release(mission, { shipIt = false } = {}) {
  const trustDomain = mission.trustDomain || "jarvis";
  const allowed = policy.releaseAllowed({ trustDomain, shipIt });
  if (!allowed.ok) return { ok: false, released: false, reason: allowed.reason };
  if (mission.releasePolicy && mission.releasePolicy.mergeToMain) {
    git.git(mission.repo, ["checkout", "-q", "main"]);
    git.git(mission.repo, ["merge", "--no-ff", "-m", `FactoryV2 release ${mission.id}`, mission.branch]);
    const steps = runReleaseSteps(mission);
    return { ok: steps.ok, released: steps.ok, mergedToMain: true, reason: steps.reason || allowed.reason, steps };
  }
  const steps = runReleaseSteps(mission);
  return { ok: steps.ok, released: steps.ok, mergedToMain: false, reason: steps.reason || allowed.reason, steps };
}

function runReleaseSteps(mission) {
  const policy = mission.releasePolicy || {};
  const steps = [];
  for (const name of ["rebuildCommand", "deployCommand", "smokeCommand"]) {
    if (!policy[name]) continue;
    const result = run(policy[name], mission.repo);
    steps.push({ name, ...result });
    if (!result.passed) {
      const rollback = policy.rollbackCommand ? run(policy.rollbackCommand, mission.repo) : { skipped: true };
      steps.push({ name: "rollbackCommand", ...rollback });
      return { ok: false, reason: `${name}-failed`, steps, rolledBack: !!policy.rollbackCommand };
    }
  }
  return { ok: true, steps, rolledBack: false };
}

function run(command, cwd) {
  const r = spawnSync("/bin/bash", ["-lc", command], { cwd, encoding: "utf8", timeout: 120000 });
  return { command, passed: r.status === 0, exitCode: r.status, output: `${r.stdout || ""}${r.stderr || ""}`.slice(-1000) };
}

module.exports = { integrate, release, runReleaseSteps };
