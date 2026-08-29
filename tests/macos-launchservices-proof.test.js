"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const launchservices = require("../src/launchservices");
const H = require("./helpers");

function main() {
  if (process.env.FACTORYV2_RUN_MACOS_LS !== "1") {
    console.log("macOS LaunchServices proof skipped unless FACTORYV2_RUN_MACOS_LS=1");
    return;
  }
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/open")) {
    console.log("macOS LaunchServices proof skipped on this platform");
    return;
  }
  const root = H.tmp("factoryv2-macos-ls-");
  const app = launchservices.createDisposableApp({ root, name: "Candidate", identity: "FactoryV2 Candidate LS Proof" });
  const proof = launchservices.openAndVerifyDisposableApp(app);
  try {
    assert.strictEqual(proof.ok, true, JSON.stringify(proof));
    assert.strictEqual(proof.command.command, "/usr/bin/open");
    assert.deepStrictEqual(proof.command.args, ["-n", app.appPath]);
    assert.strictEqual(proof.identity, "FactoryV2 Candidate LS Proof");
  } finally {
    const cleanup = launchservices.cleanupPid(proof.pid);
    assert.strictEqual(cleanup.ok, true, JSON.stringify(cleanup));
  }
  console.log("macOS LaunchServices proof passed");
}

try {
  main();
} catch (e) {
  console.error(e.stack || e.message);
  process.exit(1);
}
