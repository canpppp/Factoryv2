"use strict";

const fs = require("node:fs");
const path = require("node:path");
const journal = require("./journal");
const { createController } = require("./controller");
const { createAdapter } = require("./adapters");
const { createChannelRegistry } = require("./channels");

const NOTIFICATION_TYPES = new Set(["READY_FOR_HUMAN_CHECK", "HUMAN_DECISION_REQUIRED", "BLOCKED_EXTERNAL", "SHIPPED"]);

function createDaemon({ root, engine = process.env.FACTORYV2_ENGINE || "claude", pollMs = 5000, adapterFactory, notifier = defaultNotifier } = {}) {
  if (!root) throw new Error("factoryd needs root");
  const makeAdapter = adapterFactory || ((config) => createAdapter(config));
  const channels = createChannelRegistry({ root, adapterFactory: makeAdapter });
  let stopping = false;

  async function runOnce() {
    channels.ensureDefaults();
    clearExpiredBackoffs(root);
    const state = journal.load(root);
    const providerBackoff = state.providerBackoffs.get(engine);
    let controllerResult = { ok: true, summary: "provider backoff" };
    const controllerWork = [...state.goals.values()].some((goal) => goal.state === "queued")
      || [...state.missions.values()].some((mission) => ["queued", "building", "repair", "verifying", "reviewing", "integrating", "candidate", "accepting"].includes(mission.state));
    if (controllerWork && (!providerBackoff || Date.parse(providerBackoff.until) <= Date.now())) {
      controllerResult = await createController({ root, adapter: makeAdapter({ engine }) }).run({ maxSteps: 10 });
      if (controllerResult.backoff) scheduleDaemonBackoff(root, engine, controllerResult.summary);
    }
    const channelWork = [...state.channels.values()].some((channel) => channel.currentJob || channel.queue.length);
    const channelResult = channelWork ? await channels.runNext() : { progressed: false, summary: "channels idle" };
    deliverNotifications(root, notifier);
    journal.writeSnapshot(root);
    return { controller: controllerResult, channel: channelResult };
  }

  async function start() {
    journal.append(root, { type: "daemon.started", pid: process.pid, engine });
    while (!stopping) {
      try {
        await runOnce();
      } catch (error) {
        journal.append(root, { type: "daemon.error", message: error.message, code: error.code || null });
      }
      if (!stopping) await sleep(pollMs);
    }
    journal.append(root, { type: "daemon.stopped", pid: process.pid });
  }

  function stop() { stopping = true; }
  return { runOnce, start, stop, channels };
}

function deliverNotifications(root, notifier) {
  const p = journal.paths(root);
  const cursorPath = path.join(p.daemon, "notifications.cursor");
  const state = journal.load(root);
  let cursor = 0;
  try { cursor = Number(fs.readFileSync(cursorPath, "utf8")) || 0; } catch {}
  for (let index = cursor; index < state.events.length; index++) {
    const notification = notificationFor(state.events[index]);
    if (notification && NOTIFICATION_TYPES.has(notification.type)) notifier(notification);
  }
  fs.writeFileSync(cursorPath, String(state.events.length));
}

function notificationFor(event) {
  if (event.type === "receipt" && event.status === "READY_FOR_HUMAN_CHECK") return { type: "READY_FOR_HUMAN_CHECK", id: event.missionId, message: event.summary };
  if (event.type === "mission.state" && event.to === "blocked") return { type: /external/i.test(event.blocker || "") ? "BLOCKED_EXTERNAL" : "HUMAN_DECISION_REQUIRED", id: event.missionId, message: event.blocker };
  if (event.type === "goal.state" && event.to === "blocked") return { type: "HUMAN_DECISION_REQUIRED", id: event.goalId, message: event.blocker };
  if (event.type === "release.evaluated" && event.result?.released) return { type: "SHIPPED", id: event.missionId, message: event.result.reason };
  return null;
}

function defaultNotifier(notification) {
  process.stdout.write(`${notification.type} ${notification.id || ""} ${notification.message || ""}\n`);
}

function scheduleDaemonBackoff(root, provider, reason) {
  const previous = journal.load(root).providerBackoffs.get(provider);
  const attempt = (previous?.attempt || 0) + 1;
  const delayMs = Math.min(15 * 60 * 1000, 5000 * (2 ** (attempt - 1)));
  journal.append(root, { type: "provider.backoff.scheduled", provider, attempt, reason, until: new Date(Date.now() + delayMs).toISOString() });
}

function clearExpiredBackoffs(root) {
  for (const [provider, backoff] of journal.load(root).providerBackoffs) {
    if (Date.parse(backoff.until) <= Date.now()) journal.append(root, { type: "provider.backoff.cleared", provider });
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { createDaemon, notificationFor, deliverNotifications, scheduleDaemonBackoff, clearExpiredBackoffs, NOTIFICATION_TYPES };
