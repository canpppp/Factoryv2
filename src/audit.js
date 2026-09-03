"use strict";

const fs = require("node:fs");
const path = require("node:path");
const journal = require("./journal");

function productionAudit(root) {
  const sourceRoot = path.join(__dirname, "..");
  const cli = fs.readFileSync(path.join(sourceRoot, "bin/factoryv2.js"), "utf8");
  const state = root ? journal.load(root) : { events: [], channels: new Map() };
  const events = state.events || [];
  const exercised = new Set(events.filter((event) => event.type === "channel.job.finished").map((event) => event.channelId));
  const liveAgent = events.some((event) => event.type === "agent.receipt" || event.type === "token.usage");
  const daemonRestart = new Set(events.filter((event) => event.type === "daemon.started").map((event) => event.pid)).size >= 2;
  const resumed = events.some((event) => event.type === "token.usage" && event.reusedSession);
  const dispatch = events.some((event) => event.type === "channel.job.queued") && events.some((event) => event.type === "channel.job.finished");
  const tokenReceipt = events.some((event) => event.type === "token.usage" && Object.hasOwn(event, "promptContextEstimate") && Object.hasOwn(event, "cacheReadTokens"));
  const quota = events.some((event) => event.type === "provider.backoff.scheduled");
  const deterministic = events.some((event) => event.type === "channel.job.finished" && event.result?.deterministic);

  return [
    item("A", "normal run uses a real adapter", !cli.includes("fakeAdapter") ? (liveAgent ? "live-proved" : "implemented") : "failed"),
    item("B", "daemon survives outer controller", daemonRestart ? "live-proved" : "implemented"),
    item("C", "Claude channel persists and resumes", resumed ? "live-proved" : "implemented"),
    item("D", "six channels exist; three exercised", state.channels?.size === 6 && exercised.size >= 3 ? "live-proved" : "implemented"),
    item("E", "JARVIS dispatch and result retrieval", dispatch ? "live-proved" : "implemented"),
    item("F", "compact goal and selective skills", fs.existsSync(path.join(sourceRoot, "skills/index.json")) ? "protocol-proved" : "failed"),
    item("G", "token governor evidence", tokenReceipt ? "live-proved" : "implemented"),
    item("H", "quota backoff and deterministic continuation", quota && deterministic ? "live-proved" : "implemented"),
    item("I", "concise operator-only result", "implemented")
  ];
}

function item(id, title, status) { return { id, title, status }; }

function renderProductionAudit(root) {
  return productionAudit(root).map((entry) => `${entry.id}. ${entry.status.toUpperCase()} ${entry.title}`).join("\n");
}

function remainingLimitations(root) {
  return productionAudit(root).filter((entry) => entry.status !== "live-proved" && entry.status !== "protocol-proved");
}

module.exports = { productionAudit, renderProductionAudit, remainingLimitations };
