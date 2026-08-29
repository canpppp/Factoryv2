"use strict";

const { spawnSync } = require("node:child_process");

for (const file of ["tests/f0-f1-proof.test.js", "tests/jarvis-docs-test-proof.test.js", "tests/f2-envelope-proof.test.js", "tests/f3-f5-proof.test.js", "tests/production-contract-proof.test.js", "tests/cli-proof.test.js", "tests/candidate-isolation-proof.test.js", "tests/human-rejection-loop-proof.test.js", "tests/endurance-proof.test.js", "tests/phase-restart-proof.test.js", "tests/synthetic-jarvis-acceptance-proof.test.js", "tests/release-train-proof.test.js"]) {
  const r = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status);
}
