"use strict";

function createChannelTools(registry) {
  return {
    "channel.list": async () => registry.list().map(summary),
    "channel.send": async ({ channelId, prompt, kind, deterministic }) => registry.send(channelId, prompt, { kind, deterministic }),
    "channel.status": async ({ channelId }) => summary(registry.status(channelId)),
    "channel.result": async ({ channelId }) => registry.result(channelId),
    "channel.cancel": async ({ channelId }) => summary(registry.cancel(channelId)),
    "channel.resume": async ({ channelId }) => summary(registry.resume(channelId))
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
    latestResult: channel.latestResult
  };
}

module.exports = { createChannelTools, summary };
