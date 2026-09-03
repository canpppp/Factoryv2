"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const audit = require("../src/audit");
const H = require("./helpers");

function main() {
  const items = audit.productionAudit();
  assert.strictEqual(items.length, 9);
  assert.deepStrictEqual(items.map((x) => x.id), "ABCDEFGHI".split(""));
  assert.ok(items.some((x) => x.id === "A" && x.status === "implemented"));
  assert.ok(items.some((x) => x.id === "F" && x.status === "protocol-proved"));

  const root = H.tmp("factoryv2-audit-");
  const r = spawnSync(process.execPath, [path.join(__dirname, "../bin/factoryv2.js"), "--root", root, "audit"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /A\. IMPLEMENTED normal run uses a real adapter/);
  assert.match(r.stdout, /F\. PROTOCOL-PROVED compact goal and selective skills/);

  console.log("Truthful control-plane audit proof passed");
}

try {
  main();
} catch (e) {
  console.error(e.stack || e.message);
  process.exit(1);
}
