"use strict";

const assert = require("node:assert");
const acceptance = require("../src/product-acceptance");

async function main() {
  const good = await acceptance.runProductAcceptance(
    acceptance.fakeJarvisRuntime(),
    { identity: "Synthetic JARVIS Candidate" }
  );
  assert.strictEqual(good.ok, true);
  assert.deepStrictEqual(good.results.map((r) => r.check), acceptance.REQUIRED_CHECKS);

  const bad = await acceptance.runProductAcceptance(
    acceptance.fakeJarvisRuntime({ emptyResponse: true, identity: "Wrong" }),
    { identity: "Synthetic JARVIS Candidate" }
  );
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.results.some((r) => r.check === "emptyResponseChecks" && !r.passed));
  assert.ok(bad.results.some((r) => r.check === "runtimeIdentity" && !r.passed));

  console.log("Product acceptance harness proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
