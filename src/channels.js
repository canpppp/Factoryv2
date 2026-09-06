"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const journal = require("./journal");
const lease = require("./lease");
const { createAdapter } = require("./adapters");
const modelRouter = require("./model-router");
const tokenGovernor = require("./token-governor");
const deterministic = require("./deterministic");
const { compileTask } = require("./task-compiler");
const { resolveContext, digest } = require("./context-resolver");
const { verifyWorkerResult } = require("./result-verifier");

const RECOVERABLE = new Set(["PROVIDER_QUOTA", "TIMEOUT", "AUTH_REQUIRED", "AGENT_FAILED"]);
const DEFINITION_FIELDS = ["name", "aliases", "cwd", "engine", "modelPolicy", "allowedTools", "readWriteProfile", "writeAuthority", "projectIdentity", "capsule", "capsulePath", "definitionVersion", "identityKey", "unavailableReason"];

function createChannelRegistry({ root, adapterFactory = (config) => createAdapter(config), definitionsPath } = {}) {
  if (!root) throw new Error("channel registry needs root");
  const active = new Map();
  const configPath = definitionsPath || path.join(__dirname, "../config/channels.json");

  function definitions() {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  function aliasMap() {
    const aliases = new Map();
    const configured = definitions();
    const ids = new Set(configured.map((definition) => definition.id));
    for (const definition of configured) {
      for (const alias of definition.aliases || []) {
        if (aliases.has(alias) || ids.has(alias)) throw new Error(`duplicate channel alias: ${alias}`);
        aliases.set(alias, definition.id);
      }
    }
    return aliases;
  }

  function resolveChannelId(channelId) {
    return aliasMap().get(channelId) || channelId;
  }

  function ensureDefaults() {
    const state = journal.load(root);
    for (const definition of definitions()) {
      const normalized = normalizeDefinition(definition, path.dirname(configPath));
      const existing = state.channels.get(definition.id);
      if (!existing) {
        journal.append(root, { type: "channel.registered", channel: normalized });
        continue;
      }
      const patch = Object.fromEntries(DEFINITION_FIELDS.filter((field) => JSON.stringify(existing[field]) !== JSON.stringify(normalized[field])).map((field) => [field, normalized[field]]));
      if (normalized.state === "unavailable" && existing.state !== "unavailable" && !["working", "waiting_provider", "paused"].includes(existing.state)) patch.state = "unavailable";
      if (normalized.state === "idle" && existing.state === "unavailable") patch.state = "idle";
      if (existing.identityKey && existing.identityKey !== normalized.identityKey && existing.sessionId) {
        journal.append(root, { type: "channel.identity.changed", channelId: definition.id, from: existing.identityKey, to: normalized.identityKey });
        journal.append(root, { type: "channel.session", channelId: definition.id, sessionId: null, engine: normalized.engine });
      }
      if (Object.keys(patch).length) journal.append(root, { type: "channel.updated", channelId: definition.id, patch });
    }
    return list();
  }

  function list() {
    const legacyAliases = new Set(aliasMap().keys());
    return [...journal.load(root).channels.values()].filter((channel) => !legacyAliases.has(channel.id));
  }

  function status(channelId) {
    const canonicalId = resolveChannelId(channelId);
    const channel = journal.load(root).channels.get(canonicalId);
    if (!channel) throw new Error(`unknown channel: ${channelId}`);
    return channel;
  }

  function result(channelId, jobId = null) {
    const channel = status(channelId);
    if (!jobId) return channel.latestResult;
    const found = findJobResult(root, channel.id, jobId) || { ok: false, code: "RESULT_NOT_FOUND", jobId };
    journal.append(root, { type: "channel.result.retrieved", channelId: channel.id, jobId, ok: !!found.ok, verified: !!found.verified, origin: "factoryv2" });
    return found;
  }

  function send(channelId, prompt, options = {}) {
    const channel = status(channelId);
    channelId = channel.id;
    const envelope = compileTask(channel, { ...options, prompt });
    const check = validateChannel(channel, envelope);
    if (!check.ok) throw channelError(check.reason, check.code);
    const jobId = options.jobId || options.idempotencyKey || randomUUID();
    const duplicate = findJob(channel, jobId) || findJournalJob(root, channelId, jobId);
    if (duplicate) {
      if (duplicate.envelope?.payloadDigest !== envelope.payloadDigest) throw channelError("idempotency key reused with a different canonical payload", "IDEMPOTENCY_PAYLOAD_MISMATCH");
      return duplicate;
    }
    const job = { id: jobId, requestId: envelope.requestId, prompt: envelope.objective, envelope, queuedAt: new Date().toISOString(), kind: options.kind || channel.modelPolicy?.kind || "implementation", deterministic: options.deterministic || null, attempt: 1, contextManifest: null };
    journal.append(root, { type: "channel.job.admitted", channelId, jobId, requestId: envelope.requestId, payloadDigest: envelope.payloadDigest, origin: "factoryv2" });
    journal.append(root, { type: "channel.job.queued", channelId, job, origin: "factoryv2" });
    return job;
  }

  function pause(channelId) {
    const channel = status(channelId);
    channelId = channel.id;
    const check = validateChannel(channel, { readWriteBoundary: "read-only", requestedTools: [] });
    if (!check.ok) throw channelError(check.reason, check.code);
    const runner = active.get(channelId);
    if (runner) {
      runner.action = "pause";
      if (runner.sessionId) runner.adapter.cancelThread(runner.sessionId);
    }
    journal.append(root, { type: "channel.paused", channelId });
    return status(channelId);
  }

  function resume(channelId) {
    const channel = status(channelId);
    channelId = channel.id;
    const check = validateChannel(channel, { readWriteBoundary: "read-only", requestedTools: [] });
    if (!check.ok) throw channelError(check.reason, check.code);
    journal.append(root, { type: "channel.resumed", channelId });
    return status(channelId);
  }

  function cancel(channelId) {
    const channel = status(channelId);
    channelId = channel.id;
    const runner = active.get(channelId);
    if (runner) {
      runner.action = "cancel";
      if (runner.sessionId) runner.adapter.cancelThread(runner.sessionId);
    }
    if (channel.currentJob) journal.append(root, { type: "channel.job.cancelled", channelId, jobId: channel.currentJob.id, error: "cancelled" });
    else journal.append(root, { type: "channel.updated", channelId, patch: { queue: [] } });
    return status(channelId);
  }

  async function runNext() {
    return lease.withLease(root, async () => {
      ensureDefaults();
      const state = journal.load(root);
      const legacyAliases = new Set(aliasMap().keys());
      const channel = [...state.channels.values()].find((item) => {
        const job = item.currentJob || item.queue[0];
        const backoff = state.providerBackoffs.get(item.engine);
        return !legacyAliases.has(item.id) && item.state !== "paused" && job && (deterministic.canRun(job) || !backoff || Date.parse(backoff.until) <= Date.now());
      });
      if (!channel) return { progressed: false, summary: [...state.channels.values()].some((item) => !legacyAliases.has(item.id) && (item.currentJob || item.queue.length)) ? "channels backed off" : "channels idle" };
      const job = channel.currentJob || channel.queue[0];
      const check = validateChannel(channel, job.envelope || { readWriteBoundary: "read-only", requestedTools: [] });
      if (!check.ok) {
        const result = { ok: false, jobId: job.id, error: check.reason, code: check.code };
        journal.append(root, { type: "channel.job.failed", channelId: channel.id, jobId: job.id, result, error: check.reason });
        return { progressed: true, channelId: channel.id, result };
      }
      const context = resolveContext(channel, job.envelope || {});
      if (!context.ok) {
        const result = { ok: false, jobId: job.id, error: context.reason, code: context.code, ref: context.ref };
        persistSession(root, channel.id, job, result, null);
        journal.append(root, { type: "channel.context.failed", channelId: channel.id, jobId: job.id, code: context.code, reason: context.reason, ref: context.ref, origin: "factoryv2" });
        journal.append(root, { type: "channel.job.failed", channelId: channel.id, jobId: job.id, result, error: context.reason, origin: "factoryv2" });
        return { progressed: true, channelId: channel.id, result };
      }
      job.contextManifest = context.manifest;
      journal.append(root, { type: "channel.context.resolved", channelId: channel.id, jobId: job.id, manifest: context.manifest, origin: "factoryv2" });
      if (!channel.currentJob) journal.append(root, { type: "channel.job.started", channelId: channel.id, job });
      if (deterministic.canRun(job)) {
        const result = { ...deterministic.run(job), jobId: job.id, deterministic: true, verified: true, contextManifestSha256: context.manifest.sha256, finishedAt: new Date().toISOString() };
        persistSession(root, channel.id, job, result, context.manifest);
        journal.append(root, { type: "channel.job.finished", channelId: channel.id, jobId: job.id, result, origin: "factoryv2" });
        return { progressed: true, channelId: channel.id, result };
      }
      const policy = modelRouter.route({ kind: job.kind, engine: channel.engine, failedRepairs: job.failedRepairs || 0, preferred: job.modelFallback });
      const adapter = adapterFactory({ engine: channel.engine, model: policy.model });
      const options = {
        cwd: channel.cwd,
        readOnly: channel.readWriteProfile === "read-only",
        allowedTools: channel.allowedTools,
        model: policy.model,
        maxTurns: 8,
        timeoutMs: job.envelope?.timeoutMs || 5 * 60 * 1000
      };
      const sessionId = channel.sessionId || null;
      const agentThread = sessionId ? adapter.resumeThread(sessionId, options) : adapter.startThread(options);
      const prompt = channelPrompt(channel, job, context);
      const runner = { adapter, sessionId, action: null };
      active.set(channel.id, runner);
      try {
        const receipt = await agentThread.run(prompt, {
          onThreadId(id) {
            runner.sessionId = id;
            if (id && id !== channel.sessionId) journal.append(root, { type: "channel.session", channelId: channel.id, sessionId: id, engine: channel.engine });
          }
        });
        const interruption = settleInterruption(root, channel.id, job, runner.action);
        if (interruption) return interruption;
        if (!receipt || typeof receipt.finalResponse !== "string" || !receipt.finalResponse.trim()) {
          const error = new Error("agent returned no final response");
          error.code = "MALFORMED_RESPONSE";
          throw error;
        }
        const receiptEvent = journal.append(root, {
          type: "agent.receipt",
          channelId: channel.id,
          jobId: job.id,
          sessionId: receipt.sessionId || receipt.threadId || runner.sessionId || null,
          engine: receipt.engine || channel.engine,
          origin: receipt.origin || "adapter",
          finalResponseDigest: digest(receipt.finalResponse)
        });
        tokenGovernor.record(root, {
          scope: `channel:${channel.id}:${job.id}`,
          prompt,
          receipt,
          modelPolicy: { ...policy, reusedSession: !!sessionId },
          capsule: channel.capsule,
          retrievedSources: JSON.stringify(context.manifest.refs.map((ref) => ({ ref: ref.ref, sha256: ref.sha256, bytes: ref.bytes }))),
          selectedSkills: ["channel-operator", "task-compiler", "repo-capsule", "token-governor"],
          origin: "factoryv2"
        });
        const verification = verifyWorkerResult({ channelId: channel.id, job, receipt, contextManifest: context.manifest, resolvedContext: context.resolved });
        if (!verification.ok) {
          const result = { ok: false, jobId: job.id, code: verification.code, error: verification.reason, verification, receipt: compactReceipt(receipt), finishedAt: new Date().toISOString() };
          persistSession(root, channel.id, job, result, context.manifest);
          journal.append(root, { type: "channel.job.unverified", channelId: channel.id, jobId: job.id, result, receiptEventAt: receiptEvent.at, origin: "factoryv2" });
          return { progressed: true, channelId: channel.id, result };
        }
        const result = { ok: true, jobId: job.id, verified: true, summary: verification.summary, evidence: verification.evidence, structured: verification.structured, receipt: compactReceipt(receipt), finishedAt: new Date().toISOString() };
        persistSession(root, channel.id, job, result, context.manifest);
        journal.append(root, { type: "channel.job.finished", channelId: channel.id, jobId: job.id, result, origin: "factoryv2" });
        return { progressed: true, channelId: channel.id, result };
      } catch (error) {
        const interruption = settleInterruption(root, channel.id, job, runner.action);
        if (interruption) return interruption;
        if (error.code === "THREAD_NOT_FOUND") {
          journal.append(root, { type: "channel.session", channelId: channel.id, sessionId: null, engine: channel.engine });
          journal.append(root, { type: "channel.job.deferred", channelId: channel.id, jobId: job.id, reason: error.code, message: error.message });
          return { progressed: false, retry: true, channelId: channel.id, summary: "stale session reset" };
        }
        if (RECOVERABLE.has(error.code)) {
          const fallbackTier = policy.tier.startsWith("sol") ? "terra" : (["inventory", "log-parsing", "compression"].includes(job.kind) && policy.tier !== "luna" ? "luna" : null);
          journal.append(root, { type: "channel.job.deferred", channelId: channel.id, jobId: job.id, reason: error.code, message: error.message, fallbackTier });
          if (fallbackTier) journal.append(root, { type: "provider.fallback.selected", provider: channel.engine, from: policy.tier, to: fallbackTier, reason: "quota" });
          scheduleBackoff(root, channel.engine, error.message);
          return { progressed: false, backoff: true, channelId: channel.id, summary: `provider deferred: ${error.code}` };
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

  return { ensureDefaults, list, status, result, send, pause, resume, cancel, runNext, resolveChannelId };
}

function normalizeDefinition(definition, configDir = path.join(__dirname, "../config")) {
  const configuredCwd = definition.cwdEnv ? process.env[definition.cwdEnv] : definition.cwd;
  const cwd = configuredCwd ? expandHome(configuredCwd) : null;
  const capsulePath = definition.capsulePath ? path.resolve(configDir, definition.capsulePath) : null;
  const capsule = capsulePath && fs.existsSync(capsulePath) ? fs.readFileSync(capsulePath, "utf8").trim() : String(definition.capsule || "").trim();
  const base = {
    ...definition,
    aliases: definition.aliases || [],
    cwd,
    sessionId: null,
    modelPolicy: definition.modelPolicy || { kind: "implementation" },
    allowedTools: definition.allowedTools || ["Read", "Glob", "Grep"],
    readWriteProfile: definition.readWriteProfile || "read-only",
    writeAuthority: definition.writeAuthority || "none",
    capsule,
    capsulePath,
    definitionVersion: definition.definitionVersion || 1
  };
  const check = validateProject(base);
  base.state = check.ok ? "idle" : "unavailable";
  base.unavailableReason = check.ok ? null : check.reason;
  base.identityKey = createHash("sha256").update(JSON.stringify({ id: base.id, cwd: base.cwd, engine: base.engine, projectIdentity: base.projectIdentity || null })).digest("hex").slice(0, 24);
  return base;
}

function channelPrompt(channel, job, context = null) {
  const manifest = context?.manifest || job.contextManifest || null;
  const resolved = context?.resolved || [];
  const contextBlock = resolved.length
    ? resolved.map((item) => [`REF ${item.ref}`, `KIND ${item.kind}`, `SHA256 ${item.sha256}`, `BYTES ${item.bytes}`, item.content].join("\n")).join("\n---\n")
    : "NO RESOLVED CONTEXT";
  return [
    `CHANNEL ${channel.id}`,
    `JOB ${job.id}`,
    `PROJECT CAPSULE:\n${channel.capsule}`,
    `TASK ENVELOPE:\n${JSON.stringify(job.envelope || { objective: job.prompt })}`,
    `RESOLVED CONTEXT MANIFEST:\n${JSON.stringify(manifest || null)}`,
    `REQUIRED CONTEXT CONTENT:\n${contextBlock}`,
    "Return only structured JSON: {\"done\":true,\"channelId\":\"...\",\"jobId\":\"...\",\"summary\":\"...\",\"evidence\":[\"...\"],\"contextManifestSha256\":\"...\"}.",
    "Do not claim completion unless the objective and required evidence are satisfied."
  ].join("\n");
}

function validateChannel(channel, envelope = {}) {
  const project = validateProject(channel);
  if (!project.ok) return project;
  if (channel.sessionId && channel.sessionEngine && channel.sessionEngine !== channel.engine) return { ok: false, code: "SESSION_IDENTITY_MISMATCH", reason: "session engine does not match channel engine" };
  const requested = envelope.readWriteBoundary || "read-only";
  if (!authorityAllows(channel.writeAuthority || "none", requested)) return { ok: false, code: "AUTHORITY_EXCEEDED", reason: `requested ${requested} exceeds ${channel.writeAuthority || "none"} authority` };
  const allowed = new Set(channel.allowedTools || []);
  if ((envelope.requestedTools || []).some((tool) => !allowed.has(tool))) return { ok: false, code: "TOOL_POLICY_DENIED", reason: "requested tool exceeds channel policy" };
  return { ok: true };
}

function validateProject(channel) {
  if (!channel.cwd) return { ok: false, code: "CHANNEL_CWD_MISSING", reason: "channel cwd is not configured" };
  if (!fs.existsSync(channel.cwd) || !fs.statSync(channel.cwd).isDirectory()) return { ok: false, code: "CHANNEL_CWD_MISSING", reason: `channel cwd does not exist: ${channel.cwd}` };
  const identity = channel.projectIdentity || {};
  const markerPath = identity.marker ? path.join(channel.cwd, identity.marker) : null;
  if (markerPath && !fs.existsSync(markerPath)) return { ok: false, code: "CHANNEL_PROJECT_MISMATCH", reason: `project marker missing: ${identity.marker}` };
  if (identity.markerContains) {
    let marker;
    try {
      if (!markerPath || !fs.statSync(markerPath).isFile()) return { ok: false, code: "CHANNEL_PROJECT_MISMATCH", reason: "content-bound project identity needs a marker file" };
      marker = fs.readFileSync(markerPath, "utf8");
    } catch (error) {
      const denied = error.code === "EACCES" || error.code === "EPERM";
      return { ok: false, code: denied ? "CHANNEL_ROOT_PERMISSION_DENIED" : "CHANNEL_PROJECT_MISMATCH", reason: denied ? `project root permission denied: ${channel.cwd}` : `project marker unreadable: ${identity.marker}` };
    }
    if (!marker.includes(identity.markerContains)) return { ok: false, code: "CHANNEL_PROJECT_MISMATCH", reason: `project marker content does not match: ${identity.marker}` };
  }
  if (identity.gitRemote) {
    const result = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: channel.cwd, encoding: "utf8" });
    if (result.status !== 0 || !String(result.stdout).includes(identity.gitRemote)) return { ok: false, code: "CHANNEL_PROJECT_MISMATCH", reason: `git remote does not match ${identity.gitRemote}` };
  }
  return { ok: true };
}

function authorityAllows(granted, requested) {
  const levels = { none: 0, "read-only": 0, workspace: 1, "workspace-write": 1, external: 2, destructive: 3 };
  return (levels[requested] ?? 99) <= (levels[granted] ?? -1);
}

function findJob(channel, jobId) {
  if (channel.currentJob?.id === jobId) return channel.currentJob;
  return channel.queue.find((job) => job.id === jobId) || null;
}

function findJournalJob(root, channelId, jobId) {
  const events = journal.load(root).events;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.channelId === channelId && event.type === "channel.job.queued" && event.job?.id === jobId) return event.job;
  }
  return null;
}

function findJobResult(root, channelId, jobId) {
  const events = journal.load(root).events;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.channelId === channelId && event.jobId === jobId && ["channel.job.finished", "channel.job.failed", "channel.job.cancelled", "channel.job.unverified"].includes(event.type)) {
      return event.result || { ok: false, jobId, error: event.error || event.type };
    }
  }
  return null;
}

function channelError(message, code) {
  const error = new Error(message);
  error.code = code || "CHANNEL_REFUSED";
  return error;
}

function settleInterruption(root, channelId, job, action) {
  if (action === "pause") {
    journal.append(root, { type: "channel.job.deferred", channelId, jobId: job.id, reason: "PAUSED", message: "paused by operator" });
    return { progressed: false, paused: true, channelId, summary: "channel paused" };
  }
  if (action === "cancel") return { progressed: true, cancelled: true, channelId, result: { ok: false, jobId: job.id, code: "CANCELLED", error: "cancelled" } };
  return null;
}

function expandHome(value) {
  return String(value).replace("${HOME}", os.homedir());
}

function compactReceipt(receipt) {
  return { engine: receipt.engine, sessionId: receipt.sessionId || receipt.threadId, metadata: receipt.metadata || {} };
}

function persistSession(root, channelId, job, result, contextManifest = null) {
  const dir = path.join(journal.paths(root).sessions, channelId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeSessionFileName(job.id)}.json`);
  fs.writeFileSync(file, JSON.stringify({ channelId, job, contextManifest, result }, null, 2));
}

function safeSessionFileName(jobId) {
  return createHash("sha256").update(String(jobId)).digest("hex");
}

function scheduleBackoff(root, provider, reason) {
  const previous = journal.load(root).providerBackoffs.get(provider);
  const attempt = (previous?.attempt || 0) + 1;
  const delayMs = Math.min(15 * 60 * 1000, 5000 * (2 ** (attempt - 1)));
  journal.append(root, { type: "provider.backoff.scheduled", provider, attempt, reason, until: new Date(Date.now() + delayMs).toISOString() });
}

module.exports = { createChannelRegistry, normalizeDefinition, channelPrompt, scheduleBackoff, validateChannel, validateProject, authorityAllows };
