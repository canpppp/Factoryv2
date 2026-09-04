"use strict";

function createChannelTools(registry) {
  return {
    "channel.list": async () => registry.list().map(summary),
    "channel.send": async (params) => registry.send(params.channelId, params.objective || params.prompt, {
      jobId: params.jobId,
      kind: params.kind,
      contextRefs: params.contextRefs,
      evidenceRequired: params.evidenceRequired,
      readWriteBoundary: params.readWriteBoundary,
      doneCondition: params.doneCondition,
      tokenBudget: params.tokenBudget,
      timeoutMs: params.timeoutMs,
      priority: params.priority,
      requestedTools: params.requestedTools
    }),
    "channel.status": async ({ channelId }) => summary(registry.status(channelId)),
    "channel.result": async ({ channelId }) => registry.result(channelId),
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
