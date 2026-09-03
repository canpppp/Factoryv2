"use strict";

const journal = require("./journal");

function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text || ""), "utf8") / 4);
}

function record(root, { scope, prompt, receipt, modelPolicy, escalationReason = null, capsule = "", retrievedSources = "", repeatedContextAvoidedTokens = 0, selectedSkills = [] }) {
  const metadata = receipt?.metadata || {};
  const promptContextEstimate = estimateTokens(prompt);
  const inputTokens = metadata.inputTokens ?? null;
  const event = journal.append(root, {
    type: "token.usage",
    scope,
    engine: receipt?.engine || null,
    model: metadata.model || modelPolicy?.model || null,
    promptContextEstimate,
    contextTokens: inputTokens ?? promptContextEstimate,
    contextMeasurement: inputTokens == null ? "estimate" : "provider",
    inputTokens,
    outputTokens: metadata.outputTokens ?? estimateTokens(receipt?.finalResponse),
    outputBytes: Buffer.byteLength(String(receipt?.finalResponse || "")),
    cacheReadTokens: metadata.cacheReadTokens ?? null,
    cacheWriteTokens: metadata.cacheWriteTokens ?? null,
    reusedSession: !!modelPolicy?.reusedSession,
    costUsd: metadata.costUsd ?? null,
    escalationReason: escalationReason || modelPolicy?.escalationReason || null,
    capsuleTokens: estimateTokens(capsule),
    retrievedSourceTokens: estimateTokens(retrievedSources),
    repeatedContextAvoidedTokens: Math.max(0, Number(repeatedContextAvoidedTokens) || 0),
    selectedSkills: Array.isArray(selectedSkills) ? selectedSkills.slice(0, 10) : []
  });
  return event;
}

function measureReduction({ baseline, compact }) {
  const before = estimateTokens(baseline);
  const after = estimateTokens(compact);
  return { before, after, saved: Math.max(0, before - after), reductionPercent: before ? Math.round((1 - (after / before)) * 1000) / 10 : 0 };
}

module.exports = { estimateTokens, record, measureReduction };
