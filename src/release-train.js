"use strict";

const policy = require("./policy");
const git = require("./git");

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
    return { ok: true, released: true, mergedToMain: true, reason: allowed.reason };
  }
  return { ok: true, released: true, mergedToMain: false, reason: allowed.reason };
}

module.exports = { integrate, release };
