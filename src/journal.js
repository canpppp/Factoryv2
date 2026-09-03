"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const report = require("./report");

function paths(root) {
  const r = path.resolve(root || process.env.FACTORYV2_HOME || path.join(os.homedir(), ".factoryv2"));
  return {
    root: r,
    journal: path.join(r, "events.jsonl"),
    snapshot: path.join(r, "snapshot.json"),
    worktrees: path.join(r, "worktrees"),
    locks: path.join(r, "locks"),
    receipts: path.join(r, "receipts")
    ,sessions: path.join(r, "sessions")
    ,memory: path.join(r, "memory")
    ,daemon: path.join(r, "daemon")
  };
}

function ensure(root) {
  const p = paths(root);
  for (const d of [p.root, p.worktrees, p.locks, p.receipts, p.sessions, p.memory, p.daemon]) fs.mkdirSync(d, { recursive: true });
  return p;
}

function append(root, event, now = Date.now) {
  const p = ensure(root);
  const e = { at: new Date(now()).toISOString(), ...event };
  if (!e.type) throw new Error("journal event needs type");
  const fd = fs.openSync(p.journal, "a");
  try {
    fs.writeSync(fd, JSON.stringify(e) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return e;
}

function read(root) {
  const p = paths(root);
  let text = "";
  try { text = fs.readFileSync(p.journal, "utf8"); } catch { return { events: [], truncated: false, corrupt: false }; }
  const raw = text.split("\n");
  const events = [];
  let truncated = false;
  let corrupt = false;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      if (i === raw.length - 1) truncated = true;
      else corrupt = true;
      break;
    }
  }
  return { events, truncated, corrupt };
}

function materialize(events) {
  const goals = new Map();
  const missions = new Map();
  const receipts = [];
  const channels = new Map();
  const providerBackoffs = new Map();
  for (const e of events) {
    if (e.type === "goal.enqueued") goals.set(e.goalId, { id: e.goalId, ...e.goal, state: "queued" });
    if (e.type === "goal.state") Object.assign(goals.get(e.goalId) || {}, { state: e.to, updatedAt: e.at });
    if (e.type === "mission.created") missions.set(e.missionId, { id: e.missionId, ...e.mission, state: "queued" });
    if (e.type === "mission.state") Object.assign(missions.get(e.missionId) || {}, {
      state: e.to,
      blocker: e.blocker || null,
      updatedAt: e.at
    });
    if (e.type === "mission.field") {
      const m = missions.get(e.missionId);
      const allowed = ["workerThreadId", "reviewerThreadId", "worktree", "attempts", "repairRounds", "lastFindings", "lastGateResults", "commit", "integration", "candidate", "acceptance", "release", "replacements"];
      if (m && allowed.includes(e.field)) m[e.field] = e.value;
    }
    if (e.type === "receipt") receipts.push(e);
    if (e.type === "channel.registered") channels.set(e.channel.id, { ...e.channel, queue: [], currentJob: null, latestResult: null, heartbeat: null, state: "idle" });
    if (e.type === "channel.updated") Object.assign(channels.get(e.channelId) || {}, e.patch || {});
    if (e.type === "channel.job.queued") {
      const channel = channels.get(e.channelId);
      if (channel) channel.queue.push(e.job);
    }
    if (e.type === "channel.job.started") {
      const channel = channels.get(e.channelId);
      if (channel) {
        channel.queue = channel.queue.filter((job) => job.id !== e.job.id);
        channel.currentJob = e.job;
        channel.state = "working";
        channel.heartbeat = e.at;
      }
    }
    if (e.type === "channel.job.deferred") {
      const channel = channels.get(e.channelId);
      if (channel?.currentJob && e.fallbackTier) channel.currentJob.modelFallback = e.fallbackTier;
    }
    if (e.type === "channel.session") {
      const channel = channels.get(e.channelId);
      if (channel) channel.sessionId = e.sessionId;
    }
    if (["channel.job.finished", "channel.job.failed", "channel.job.cancelled"].includes(e.type)) {
      const channel = channels.get(e.channelId);
      if (channel) {
        channel.latestResult = e.result || { ok: false, error: e.error || e.type };
        channel.currentJob = null;
        channel.state = e.type === "channel.job.finished" ? "idle" : "blocked";
        channel.heartbeat = e.at;
      }
    }
    if (e.type === "channel.paused") {
      const channel = channels.get(e.channelId);
      if (channel) channel.state = "paused";
    }
    if (e.type === "channel.resumed") {
      const channel = channels.get(e.channelId);
      if (channel) channel.state = channel.currentJob ? "working" : "idle";
    }
    if (e.type === "channel.heartbeat") {
      const channel = channels.get(e.channelId);
      if (channel) channel.heartbeat = e.at;
    }
    if (e.type === "provider.backoff.scheduled") providerBackoffs.set(e.provider, { until: e.until, attempt: e.attempt, reason: e.reason });
    if (e.type === "provider.backoff.cleared") providerBackoffs.delete(e.provider);
  }
  return { goals, missions, receipts, channels, providerBackoffs };
}

function load(root) {
  const r = read(root);
  if (r.corrupt) return { ok: false, reason: "journal-corrupt", ...r, ...materialize(r.events) };
  return { ok: true, reason: null, ...r, ...materialize(r.events) };
}

function writeSnapshot(root) {
  const state = load(root);
  if (!state.ok) return state;
  const p = ensure(root);
  const payload = {
    version: 1,
    builtFromEvents: state.events.length,
    builtAt: new Date().toISOString(),
    goals: Object.fromEntries(state.goals),
    missions: Object.fromEntries(state.missions)
    ,channels: Object.fromEntries(state.channels)
    ,providerBackoffs: Object.fromEntries(state.providerBackoffs)
  };
  const tmp = `${p.snapshot}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, p.snapshot);
  return payload;
}

function eventsFor(state, missionId) {
  return state.events.filter((e) => e.missionId === missionId || e.goalId === missionId);
}

function renderStatus(state) {
  if (!state.ok) return `BLOCKED ${state.reason}`;
  const lines = [];
  for (const g of state.goals.values()) lines.push(`GOAL ${goalHumanStatus(g)} ${g.id} ${g.text}`);
  for (const m of state.missions.values()) {
    lines.push(`MISSION ${report.humanStatus(m)} ${m.id}`);
  }
  return lines.join("\n") || "no goals";
}

function goalHumanStatus(goal) {
  if (goal.state === "blocked") return "HUMAN_DECISION_REQUIRED";
  if (goal.state === "queued" || goal.state === "running") return "WORKING";
  return String(goal.state || "WORKING").toUpperCase();
}

module.exports = { paths, ensure, append, read, materialize, load, writeSnapshot, eventsFor, renderStatus, goalHumanStatus };
