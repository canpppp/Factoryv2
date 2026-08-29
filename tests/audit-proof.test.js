"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const audit = require("../src/audit");
const H = require("./helpers");

function main() {
  const items = audit.productionAudit();
  assert.strictEqual(items.length, 17);
  assert.deepStrictEqual(items.map((x) => x.id), "ABCDEFGHIJKLMNOPQ".split(""));
  assert.ok(items.some((x) => x.id === "L" && x.status === "proved"));
  assert.ok(items.some((x) => x.id === "M" && x.status === "proved"));
  assert.ok(items.some((x) => x.id === "Q" && x.status === "proved"));

  const root = H.tmp("factoryv2-audit-");
  const r = spawnSync(process.execPath, [path.join(__dirname, "../bin/factoryv2.js"), "--root", root, "audit"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /A\. PROVED one-command goal execution/);
  assert.match(r.stdout, /P\. PROVED Ship-it release train/);

  console.log("Production audit proof passed");
}

try {
  main();
} catch (e) {
  console.error(e.stack || e.message);
  process.exit(1);
}
