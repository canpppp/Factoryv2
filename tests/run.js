"use strict";

const { spawnSync } = require("node:child_process");

for (const file of ["tests/f0-f1-proof.test.js", "tests/jarvis-docs-test-proof.test.js"]) {
  const r = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status);
}
