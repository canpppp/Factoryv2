"use strict";

const { spawnSync } = require("node:child_process");
for (const file of ["tests/goal-preparation.test.js", "tests/goal-consumers-proof.test.js"]) {
  const result = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (result.status !== 0 || result.signal) process.exit(result.status || 1);
}
const hostSandboxHold = process.platform === "darwin" && process.env.FACTORYV2_TEST_NO_HOST_SANDBOX === "1";
const sandboxProofs = new Set(["tests/worker-isolation-proof.test.js", "tests/real-adapters-proof.test.js", "tests/channels-daemon-proof.test.js"]);
function held(file) {
  if (!hostSandboxHold || !sandboxProofs.has(file)) return false;
  console.log(`NOT_TESTED (macOS sandbox incident hold): ${file}`);
  return true;
}

for (const file of ["tests/owner-parser.test.js", "tests/owner-consumers-proof.test.js", "tests/linux-ownership-parser.test.js", "tests/linux-ownership-proof.test.js", "tests/controller-policy-proof.test.js", "tests/m02-r1-proof.test.js", "tests/process-lifecycle-proof.test.js", "tests/worker-isolation-proof.test.js"]) {
  if (held(file)) continue;
  const result = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (result.status !== 0 || result.signal) process.exit(result.status || 1);
}

for (const file of ["tests/real-adapters-proof.test.js", "tests/channels-daemon-proof.test.js", "tests/channel-security-proof.test.js", "tests/context-control-proof.test.js", "tests/provider-resilience-proof.test.js", "tests/f0-f1-proof.test.js", "tests/jarvis-docs-test-proof.test.js", "tests/f2-envelope-proof.test.js", "tests/f3-f5-proof.test.js", "tests/production-contract-proof.test.js", "tests/cli-proof.test.js", "tests/candidate-isolation-proof.test.js", "tests/human-rejection-loop-proof.test.js", "tests/endurance-proof.test.js", "tests/phase-restart-proof.test.js", "tests/post-review-restart-proof.test.js", "tests/synthetic-jarvis-acceptance-proof.test.js", "tests/product-acceptance-proof.test.js", "tests/release-train-proof.test.js", "tests/launchservices-proof.test.js", "tests/macos-launchservices-proof.test.js", "tests/audio-lock-proof.test.js", "tests/audit-proof.test.js"]) {
  if (held(file)) continue;
  const r = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (r.status !== 0 || r.signal) {
    console.error(`Proof failed: ${file} status=${r.status} signal=${r.signal || "none"} error=${r.error?.code || "none"}`);
    process.exit(r.status || 1);
  }
}
if (hostSandboxHold) console.log("PARTIAL: host sandbox proofs NOT_TESTED; full acceptance requires disposable Linux CI proof");
