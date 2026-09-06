"use strict";

const fs = require("node:fs");
const path = require("node:path");
const journal = require("./journal");

function productionAudit(root) {
  const sourceRoot = path.join(__dirname, "..");
  const cli = fs.readFileSync(path.join(sourceRoot, "bin/factoryv2.js"), "utf8");
  const state = root ? journal.load(root) : { events: [], channels: new Map() };
  const events = state.events || [];
  const exercised = new Set(events.filter((event) => trustedOrigin(event) && event.type === "channel.job.finished" && event.result?.verified).map((event) => event.channelId));
  const liveAgent = events.some((event) => liveReceipt(events, event));
  const daemonRestart = events.some((event) => controllerSurvival(events, event));
  const resumed = events.some((event) => resumedSession(events, event));
  const dispatch = events.some((event) => dispatchRetrieved(events, event));
  const primedContext = events.some((event) => contextResolved(events, event));
  const tokenReceipt = events.some((event) => tokenEvidence(event));
  const quota = events.some((event) => quotaContinuation(events, event));

  return [
    item("A", "normal run uses a real adapter", !cli.includes("fakeAdapter") ? (liveAgent ? "live-proved" : "implemented") : "failed"),
    item("B", "daemon survives outer controller", daemonRestart ? "live-proved" : "implemented"),
    item("C", "Claude channel persists and resumes", resumed ? "live-proved" : "implemented"),
    item("D", "six channels exist; three exercised", state.channels?.size === 6 && exercised.size >= 3 ? "live-proved" : "implemented"),
    item("E", "JARVIS dispatch and result retrieval", dispatch ? "live-proved" : "implemented"),
    item("F", "compact goal and selective skills", primedContext ? "live-proved" : (fs.existsSync(path.join(sourceRoot, "skills/index.json")) ? "protocol-proved" : "failed")),
    item("G", "token governor evidence", tokenReceipt ? "live-proved" : "implemented"),
    item("H", "quota backoff and deterministic continuation", quota ? "live-proved" : "implemented"),
    item("I", "concise operator-only result", "implemented")
  ];
}

function item(id, title, status) { return { id, title, status }; }

function liveReceipt(events, event) {
  if (event.type !== "agent.receipt" || !trustedOrigin(event)) return false;
  return !!(event.channelId && event.jobId && event.sessionId && event.engine)
    && events.some((candidate) => trustedOrigin(candidate) && candidate.type === "channel.job.finished" && candidate.channelId === event.channelId && candidate.jobId === event.jobId && candidate.result?.verified);
}

function controllerSurvival(events, event) {
  if (event.type !== "controller.stopped" || !event.scenarioId || !trustedOrigin(event)) return false;
  return events.some((candidate) => trustedOrigin(candidate) && candidate.type === "channel.job.finished" && candidate.scenarioId === event.scenarioId && candidate.result?.verified);
}

function resumedSession(events, event) {
  if (event.type !== "token.usage" || !event.reusedSession || !trustedOrigin(event)) return false;
  const [, channelId, jobId] = String(event.scope || "").split(":");
  return !!(channelId && jobId) && events.some((candidate) => trustedOrigin(candidate) && candidate.type === "agent.receipt" && candidate.channelId === channelId && candidate.jobId === jobId && candidate.sessionId);
}

function dispatchRetrieved(events, event) {
  if (event.type !== "channel.result.retrieved" || !event.channelId || !event.jobId || !event.ok || !event.verified || !trustedOrigin(event)) return false;
  const retrievedAt = Date.parse(event.at || "");
  return events.some((candidate) => trustedOrigin(candidate) && candidate.type === "channel.job.queued" && candidate.channelId === event.channelId && candidate.job?.id === event.jobId)
    && events.some((candidate) => {
      const finishedAt = Date.parse(candidate.at || "");
      return trustedOrigin(candidate)
        && candidate.type === "channel.job.finished"
        && candidate.channelId === event.channelId
        && candidate.jobId === event.jobId
        && candidate.result?.verified
        && Number.isFinite(finishedAt)
        && Number.isFinite(retrievedAt)
        && finishedAt <= retrievedAt;
    });
}

function contextResolved(events, event) {
  return trustedOrigin(event)
    && event.type === "channel.context.resolved"
    && events.some((candidate) => trustedOrigin(candidate) && candidate.type === "channel.job.queued" && candidate.channelId === event.channelId && candidate.job?.id === event.jobId)
    && event.manifest?.sha256
    && Array.isArray(event.manifest.refs)
    && event.manifest.refs.some((ref) => ref.kind !== "fixture" && ref.sha256 && Number.isInteger(ref.bytes));
}

function tokenEvidence(event) {
  return event.type === "token.usage"
    && trustedOrigin(event)
    && /^channel:[^:]+:[^:]+$/.test(String(event.scope || ""))
    && Object.hasOwn(event, "promptContextEstimate")
    && Object.hasOwn(event, "cacheReadTokens");
}

function quotaContinuation(events, event) {
  if (event.type !== "provider.backoff.scheduled" || !event.scenarioId || !trustedOrigin(event)) return false;
  return events.some((candidate) => trustedOrigin(candidate) && candidate.type === "deterministic.continuation" && candidate.scenarioId === event.scenarioId && candidate.channelId && candidate.jobId);
}

function trustedOrigin(event) {
  return !!event && ["factoryv2", "adapter", "runtime", "live", "deterministic"].includes(event.origin);
}

function renderProductionAudit(root) {
  return productionAudit(root).map((entry) => `${entry.id}. ${entry.status.toUpperCase()} ${entry.title}`).join("\n");
}

function remainingLimitations(root) {
  return productionAudit(root).filter((entry) => entry.status !== "live-proved" && entry.status !== "protocol-proved");
}

module.exports = { productionAudit, renderProductionAudit, remainingLimitations };
