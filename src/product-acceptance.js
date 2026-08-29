"use strict";

const REQUIRED_CHECKS = Object.freeze([
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

async function runProductAcceptance(runtime, expected = {}) {
  const results = [];
  const run = async (check, fn) => {
    try {
      const value = await fn();
      results.push({ check, passed: value === true, detail: value === true ? "ok" : String(value || "failed") });
    } catch (e) {
      results.push({ check, passed: false, detail: e.message });
    }
  };

  await run("startup", () => runtime.start());
  await run("restart", () => runtime.restart());
  await run("normalTextTurns", async () => {
    const reply = await runtime.turn("Say hello in one short sentence.");
    return typeof reply === "string" && reply.trim().length > 0 && reply.length < 240;
  });
  await run("structuredViews", async () => {
    const view = await runtime.view("channels");
    return view && view.kind === "structured" && Array.isArray(view.items);
  });
  await run("clockTruth", async () => {
    const clock = await runtime.clock();
    return !!(clock && clock.iso && clock.timezone);
  });
  await run("capabilityTruth", async () => {
    const capability = await runtime.capability("external-write");
    return capability && capability.allowed === false && capability.authority === "protected";
  });
  await run("emptyResponseChecks", async () => {
    const reply = await runtime.turn("Return a useful acknowledgement.");
    return typeof reply === "string" && reply.trim().length > 0;
  });
  await run("guestMode", async () => {
    const guest = await runtime.guestMode();
    return guest && guest.private === true && guest.persisted === false;
  });
  await run("interruptions", () => runtime.interrupt());
  await run("speechNormalization", async () => {
    const normalized = await runtime.normalizeSpeech("ship it at two thirty");
    return normalized === "ship it at 2:30";
  });
  await run("processHealth", async () => {
    const health = await runtime.health();
    return health && health.pid && health.running === true;
  });
  await run("runtimeIdentity", async () => {
    const identity = await runtime.identity();
    return identity === expected.identity;
  });

  return { ok: results.every((r) => r.passed), results };
}

function fakeJarvisRuntime(overrides = {}) {
  const state = { running: false, pid: process.pid };
  return {
    async start() { state.running = true; return true; },
    async restart() { state.running = false; state.running = true; return true; },
    async turn(prompt) {
      if (overrides.emptyResponse && /acknowledgement/.test(prompt)) return "";
      if (overrides.verboseTurn) return "x".repeat(400);
      return "Hello.";
    },
    async view(name) { return overrides.badView ? null : { kind: "structured", name, items: [] }; },
    async clock() { return overrides.badClock ? null : { iso: "2026-08-29T00:00:00.000Z", timezone: "UTC" }; },
    async capability() { return overrides.badCapability ? { allowed: true } : { allowed: false, authority: "protected" }; },
    async guestMode() { return overrides.badGuest ? { private: false, persisted: true } : { private: true, persisted: false }; },
    async interrupt() { return overrides.badInterrupt ? "failed" : true; },
    async normalizeSpeech() { return overrides.badSpeech ? "ship it at two thirty" : "ship it at 2:30"; },
    async health() { return overrides.badHealth ? { running: false } : { pid: state.pid, running: state.running }; },
    async identity() { return overrides.identity || "Synthetic JARVIS Candidate"; }
  };
}

module.exports = { REQUIRED_CHECKS, runProductAcceptance, fakeJarvisRuntime };
