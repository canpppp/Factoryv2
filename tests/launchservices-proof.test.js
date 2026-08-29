"use strict";

const assert = require("node:assert");
const launchservices = require("../src/launchservices");
const candidate = require("../src/candidate");
const H = require("./helpers");

function main() {
  const command = launchservices.buildOpenCommand("/tmp/Candidate.app");
  assert.deepStrictEqual(command, { ok: true, command: "/usr/bin/open", args: ["-n", "/tmp/Candidate.app"] });
  assert.strictEqual(launchservices.buildOpenCommand("/tmp/Stable.txt").ok, false);

  const root = H.tmp("factoryv2-ls-root-");
  const repo = H.makeBugRepo();
  const cand = candidate.createCandidate(root, {
    id: "mission-ls",
    commit: "abc123",
    worktree: repo,
    candidateSpec: {
      identity: "Candidate",
      launchServices: {
        appPath: "/tmp/Candidate.app",
        identity: "Candidate",
        expectedIdentity: "Candidate"
      }
    }
  });
  assert.strictEqual(cand.launchServices.ok, true);
  assert.strictEqual(cand.launchServices.command.command, "/usr/bin/open");
  assert.deepStrictEqual(cand.launchServices.command.args, ["-n", "/tmp/Candidate.app"]);

  const bad = candidate.createCandidate(root, {
    id: "mission-ls-bad",
    commit: "def456",
    worktree: repo,
    candidateSpec: {
      identity: "Candidate",
      launchServices: {
        appPath: "/tmp/Candidate.app",
        identity: "Stable",
        expectedIdentity: "Candidate"
      }
    }
  });
  assert.strictEqual(bad.launchServices.ok, false);
  assert.match(bad.launchServices.reason, /identity-mismatch/);

  console.log("LaunchServices proof passed");
}

try {
  main();
} catch (e) {
  console.error(e.stack || e.message);
  process.exit(1);
}
