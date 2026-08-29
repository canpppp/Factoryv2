"use strict";

const productAcceptance = require("./product-acceptance");

const CHECKS = Object.freeze([
  "startup",
  "restart",
  "normalTextTurns",
  "structuredViews",
  "clockTruth",
  "capabilityTruth",
  "emptyResponseChecks",
  "guestMode",
  "interruptions",
  "speechNormalization",
  "processHealth",
  "runtimeIdentity"
]);

async function runSyntheticAcceptance(candidateManifest, fixture = {}) {
  if (fixture && fixture.__runtimeHarness) {
    return productAcceptance.runProductAcceptance(
      productAcceptance.fakeJarvisRuntime(fixture.overrides || {}),
      { identity: candidateManifest.identity }
    );
  }
  const results = CHECKS.map((check) => {
    const value = fixture[check];
    const passed = value === true || (check === "runtimeIdentity" && value === candidateManifest.identity);
    return {
      check,
      passed,
      detail: passed ? "ok" : failureDetail(check, value, candidateManifest)
    };
  });
  return {
    ok: results.every((r) => r.passed),
    results
  };
}

function failureDetail(check, value, candidateManifest) {
  if (check === "runtimeIdentity") {
    return `expected ${candidateManifest.identity}, got ${String(value)}`;
  }
  return value === undefined ? "missing" : `expected true, got ${String(value)}`;
}

module.exports = { CHECKS, runSyntheticAcceptance };
