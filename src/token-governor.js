"use strict";

const journal = require("./journal");

function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text || ""), "utf8") / 4);
}

function record(root, { scope, prompt, receipt, modelPolicy, escalationReason = null }) {
  const metadata = receipt?.metadata || {};
  const event = journal.append(root, {
    type: "token.usage",
    scope,
    engine: receipt?.engine || null,
    model: metadata.model || modelPolicy?.model || null,
    promptContextEstimate: estimateTokens(prompt),
    inputTokens: metadata.inputTokens ?? null,
    outputTokens: metadata.outputTokens ?? estimateTokens(receipt?.finalResponse),
    outputBytes: Buffer.byteLength(String(receipt?.finalResponse || "")),
    cacheReadTokens: metadata.cacheReadTokens ?? null,
    cacheWriteTokens: metadata.cacheWriteTokens ?? null,
    reusedSession: !!modelPolicy?.reusedSession,
    costUsd: metadata.costUsd ?? null,
    escalationReason: escalationReason || modelPolicy?.escalationReason || null
  });
  return event;
}

function measureReduction({ baseline, compact }) {
  const before = estimateTokens(baseline);
  const after = estimateTokens(compact);
  return { before, after, saved: Math.max(0, before - after), reductionPercent: before ? Math.round((1 - (after / before)) * 1000) / 10 : 0 };
}

module.exports = { estimateTokens, record, measureReduction };
