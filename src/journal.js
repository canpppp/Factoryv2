"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function paths(root) {
  const r = path.resolve(root || process.env.FACTORYV2_HOME || path.join(os.homedir(), ".factoryv2"));
  return {
    root: r,
    journal: path.join(r, "events.jsonl"),
    snapshot: path.join(r, "snapshot.json"),
    worktrees: path.join(r, "worktrees"),
    locks: path.join(r, "locks"),
    receipts: path.join(r, "receipts")
  };
}

function ensure(root) {
  const p = paths(root);
  for (const d of [p.root, p.worktrees, p.locks, p.receipts]) fs.mkdirSync(d, { recursive: true });
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
      const allowed = ["workerThreadId", "reviewerThreadId", "worktree", "attempts", "repairRounds", "lastFindings", "lastGateResults", "commit"];
      if (m && allowed.includes(e.field)) m[e.field] = e.value;
    }
    if (e.type === "receipt") receipts.push(e);
  }
  return { goals, missions, receipts };
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
  for (const g of state.goals.values()) lines.push(`GOAL ${g.state} ${g.id} ${g.text}`);
  for (const m of state.missions.values()) {
    lines.push(`MISSION ${m.state} ${m.id} worker=${m.workerThreadId || "-"} reviewer=${m.reviewerThreadId || "-"} repairs=${m.repairRounds || 0}`);
  }
  return lines.join("\n") || "no goals";
}

module.exports = { paths, ensure, append, read, materialize, load, writeSnapshot, eventsFor, renderStatus };
