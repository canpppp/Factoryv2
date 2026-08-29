"use strict";

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

function runSyntheticAcceptance(candidateManifest, fixture = {}) {
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
