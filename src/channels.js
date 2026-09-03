"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const journal = require("./journal");
const lease = require("./lease");
const { createAdapter } = require("./adapters");
const modelRouter = require("./model-router");
const tokenGovernor = require("./token-governor");
const deterministic = require("./deterministic");

function createChannelRegistry({ root, adapterFactory = (config) => createAdapter(config), definitionsPath } = {}) {
  if (!root) throw new Error("channel registry needs root");
  const active = new Map();
  const configPath = definitionsPath || path.join(__dirname, "../config/channels.json");

  function ensureDefaults() {
    const state = journal.load(root);
    const definitions = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const definition of definitions) {
      if (state.channels.has(definition.id)) continue;
      journal.append(root, { type: "channel.registered", channel: normalizeDefinition(definition) });
    }
    return list();
  }

  function list() {
    return [...journal.load(root).channels.values()];
  }

  function status(channelId) {
    const channel = journal.load(root).channels.get(channelId);
    if (!channel) throw new Error(`unknown channel: ${channelId}`);
    return channel;
  }

  function result(channelId) {
    return status(channelId).latestResult;
  }

  function send(channelId, prompt, options = {}) {
    const channel = status(channelId);
    if (!String(prompt || "").trim()) throw new Error("channel prompt is required");
    const job = { id: options.jobId || randomUUID(), prompt: String(prompt).trim(), queuedAt: new Date().toISOString(), kind: options.kind || channel.modelPolicy?.kind || "implementation", deterministic: options.deterministic || null };
    journal.append(root, { type: "channel.job.queued", channelId, job });
    return job;
  }

  function pause(channelId) {
    status(channelId);
    const runner = active.get(channelId);
    if (runner?.sessionId) runner.adapter.cancelThread(runner.sessionId);
    journal.append(root, { type: "channel.paused", channelId });
    return status(channelId);
  }

  function resume(channelId) {
    status(channelId);
    journal.append(root, { type: "channel.resumed", channelId });
    return status(channelId);
  }

  function cancel(channelId) {
    const channel = status(channelId);
    const runner = active.get(channelId);
    if (runner?.sessionId) runner.adapter.cancelThread(runner.sessionId);
    if (channel.currentJob) journal.append(root, { type: "channel.job.cancelled", channelId, jobId: channel.currentJob.id, error: "cancelled" });
    else journal.append(root, { type: "channel.updated", channelId, patch: { queue: [] } });
    return status(channelId);
  }

  async function runNext() {
    return lease.withLease(root, async () => {
      ensureDefaults();
      const state = journal.load(root);
      const channel = [...state.channels.values()].find((item) => {
        const backoff = state.providerBackoffs.get(item.engine);
        return item.state !== "paused" && (item.currentJob || item.queue.length) && (!backoff || Date.parse(backoff.until) <= Date.now());
      });
      if (!channel) return { progressed: false, summary: [...state.channels.values()].some((item) => item.currentJob || item.queue.length) ? "channels backed off" : "channels idle" };
      const job = channel.currentJob || channel.queue[0];
      if (!channel.currentJob) journal.append(root, { type: "channel.job.started", channelId: channel.id, job });
      if (deterministic.canRun(job)) {
        const result = { ...deterministic.run(job), jobId: job.id, deterministic: true, finishedAt: new Date().toISOString() };
        persistSession(root, channel.id, job, result);
        journal.append(root, { type: "channel.job.finished", channelId: channel.id, jobId: job.id, result });
        return { progressed: true, channelId: channel.id, result };
      }
      const policy = modelRouter.route({ kind: job.kind, engine: channel.engine, failedRepairs: job.failedRepairs || 0, preferred: job.modelFallback });
      const adapter = adapterFactory({ engine: channel.engine, model: policy.model });
      const options = {
        cwd: channel.cwd,
        readOnly: channel.readWriteProfile === "read-only",
        allowedTools: channel.allowedTools,
        model: policy.model,
        maxTurns: 8
      };
      const sessionId = channel.sessionId || null;
      const agentThread = sessionId ? adapter.resumeThread(sessionId, options) : adapter.startThread(options);
      active.set(channel.id, { adapter, sessionId });
      try {
        const receipt = await agentThread.run(channelPrompt(channel, job), {
          onThreadId(id) {
            active.set(channel.id, { adapter, sessionId: id });
            if (id && id !== channel.sessionId) journal.append(root, { type: "channel.session", channelId: channel.id, sessionId: id });
          }
        });
        tokenGovernor.record(root, { scope: `channel:${channel.id}:${job.id}`, prompt: job.prompt, receipt, modelPolicy: { ...policy, reusedSession: !!sessionId } });
        const result = { ok: true, jobId: job.id, response: receipt.finalResponse, receipt: compactReceipt(receipt), finishedAt: new Date().toISOString() };
        persistSession(root, channel.id, job, result);
        journal.append(root, { type: "channel.job.finished", channelId: channel.id, jobId: job.id, result });
        return { progressed: true, channelId: channel.id, result };
      } catch (error) {
        if (error.code === "PROVIDER_QUOTA") {
          const fallbackTier = policy.tier.startsWith("sol") ? "terra" : (["inventory", "log-parsing", "compression"].includes(job.kind) && policy.tier !== "luna" ? "luna" : null);
          journal.append(root, { type: "channel.job.deferred", channelId: channel.id, jobId: job.id, reason: error.code, fallbackTier });
          if (fallbackTier) journal.append(root, { type: "provider.fallback.selected", provider: channel.engine, from: policy.tier, to: fallbackTier, reason: "quota" });
          scheduleBackoff(root, channel.engine, error.message);
          return { progressed: false, backoff: true, channelId: channel.id, summary: "provider quota" };
        }
        const result = { ok: false, jobId: job.id, error: error.message, code: error.code || "CHANNEL_FAILED" };
        persistSession(root, channel.id, job, result);
        journal.append(root, { type: "channel.job.failed", channelId: channel.id, jobId: job.id, result, error: error.message });
        return { progressed: true, channelId: channel.id, result };
      } finally {
        active.delete(channel.id);
      }
    });
  }

  return { ensureDefaults, list, status, result, send, pause, resume, cancel, runNext };
}

function normalizeDefinition(definition) {
  return {
    ...definition,
    cwd: String(definition.cwd).replace("${HOME}", os.homedir()),
    sessionId: null,
    modelPolicy: definition.modelPolicy || { kind: "implementation" },
    allowedTools: definition.allowedTools || ["Read", "Glob", "Grep"],
    readWriteProfile: definition.readWriteProfile || "read-only"
  };
}

function channelPrompt(channel, job) {
  return [`CHANNEL ${channel.id}`, `PROJECT CAPSULE: ${channel.capsule}`, `JOB ${job.id}`, job.prompt, "Return a concise operator result with evidence and any required decision."].join("\n");
}

function compactReceipt(receipt) {
  return { engine: receipt.engine, sessionId: receipt.sessionId || receipt.threadId, metadata: receipt.metadata || {} };
}

function persistSession(root, channelId, job, result) {
  const dir = path.join(journal.paths(root).sessions, channelId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${job.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ channelId, job, result }, null, 2));
}

function scheduleBackoff(root, provider, reason) {
  const previous = journal.load(root).providerBackoffs.get(provider);
  const attempt = (previous?.attempt || 0) + 1;
  const delayMs = Math.min(15 * 60 * 1000, 5000 * (2 ** (attempt - 1)));
  journal.append(root, { type: "provider.backoff.scheduled", provider, attempt, reason, until: new Date(Date.now() + delayMs).toISOString() });
}

module.exports = { createChannelRegistry, normalizeDefinition, channelPrompt, scheduleBackoff };
