"use strict";

function createChannelTools(registry) {
  return {
    "channel.list": async () => registry.list().map(summary),
    "channel.send": async (params) => registry.send(params.channelId, params.objective || params.prompt, {
      jobId: params.jobId,
      requestId: params.requestId,
      idempotencyKey: params.idempotencyKey,
      jobPackId: params.jobPackId,
      jobPackRevision: params.jobPackRevision,
      kind: params.kind,
      constraints: params.constraints,
      primingRefs: params.primingRefs,
      requiredRefs: params.requiredRefs,
      contextRefs: params.contextRefs,
      evidenceRequired: params.evidenceRequired,
      readWriteBoundary: params.readWriteBoundary,
      effectBoundary: params.effectBoundary,
      doneCondition: params.doneCondition,
      acceptanceProfile: params.acceptanceProfile,
      tokenBudget: params.tokenBudget,
      timeoutMs: params.timeoutMs,
      priority: params.priority,
      requestedTools: params.requestedTools,
      source: "jarvis-bridge"
    }),
    "channel.status": async ({ channelId }) => summary(registry.status(channelId)),
    "channel.result": async ({ channelId, jobId }) => registry.result(channelId, jobId, { source: "jarvis-bridge" }),
    "channel.cancel": async ({ channelId }) => controlReceipt(registry, channelId, "cancel"),
    "channel.resume": async ({ channelId }) => controlReceipt(registry, channelId, "resume")
  };
}

function controlReceipt(registry, channelId, action) {
  const before = registry.status(channelId);
  const jobId = before.currentJob?.id || before.queue?.[0]?.id || null;
  const changed = action === "cancel"
    ? !!(before.currentJob || before.queue?.length)
    : before.state === "paused";
  const after = registry[action](channelId);
  return {
    ...summary(after),
    operation: { action, accepted: true, changed, jobId }
  };
}

function summary(channel) {
  return {
    id: channel.id,
    name: channel.name,
    engine: channel.engine,
    state: channel.state,
    currentJob: channel.currentJob?.id || null,
    queued: channel.queue?.length || 0,
    heartbeat: channel.heartbeat,
    latestResult: channel.latestResult,
    lastSuccessfulJob: channel.lastSuccessfulJob,
    lastFailure: channel.lastFailure,
    unavailableReason: channel.unavailableReason || null
  };
}

module.exports = { createChannelTools, summary, controlReceipt };
