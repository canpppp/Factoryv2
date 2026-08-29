"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const H = require("./helpers");

function cli(root, args) {
  return spawnSync(process.execPath, [path.join(__dirname, "../bin/factoryv2.js"), "--root", root, ...args], { encoding: "utf8" });
}

async function main() {
  const root = H.tmp("factoryv2-cli-");
  const repo = H.makeBugRepo();
  const c = createController({ root, adapter: fakeAdapter({}) });
  c.enqueueGoal({ goal: "Touch credential handling", repo });

  let r = cli(root, ["status"]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /HUMAN_DECISION_REQUIRED/);

  r = cli(root, ["decisions"]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /HUMAN_DECISION_REQUIRED goal/);

  r = cli(root, ["pause"]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /paused/);
  assert.strictEqual((await c.run({ maxSteps: 1 })).summary, "paused");

  r = cli(root, ["resume"]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /resumed/);

  console.log("CLI proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
