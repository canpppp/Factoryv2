"use strict";

const { createHash } = require("node:crypto");

const PRIORITIES = new Set(["low", "normal", "high"]);

function compileTask(channel, input = {}) {
  const tokenBudget = clamp(input.tokenBudget, 256, 32000, 4000);
  const timeoutMs = clamp(input.timeoutMs, 1000, 30 * 60 * 1000, 5 * 60 * 1000);
  const envelope = {
    version: 2,
    channel: channel.id,
    requestId: bounded(input.requestId || input.jobId || input.idempotencyKey || `${channel.id}:request`, 300, "requestId"),
    jobPackId: bounded(input.jobPackId || `${channel.id}:default-pack`, 300, "jobPackId"),
    jobPackRevision: bounded(String(input.jobPackRevision || channel.definitionVersion || 1), 80, "jobPackRevision"),
    objective: bounded(input.objective || input.prompt, 4000, "objective"),
    constraints: boundedList(input.constraints, 12, 500),
    primingRefs: boundedList(input.primingRefs || input.requiredRefs, 12, 300),
    requiredRefs: boundedList(input.requiredRefs, 12, 300),
    contextRefs: boundedList(input.contextRefs, 8, 300),
    evidenceRequired: boundedList(input.evidenceRequired, 8, 300),
    readWriteBoundary: input.readWriteBoundary || "read-only",
    effectBoundary: input.effectBoundary || input.readWriteBoundary || "read-only",
    doneCondition: bounded(input.doneCondition || "Return a concise evidence-backed result.", 1000, "doneCondition"),
    tokenBudget,
    timeoutMs,
    budgets: { tokenBudget, timeoutMs },
    priority: PRIORITIES.has(input.priority) ? input.priority : "normal",
    requestedTools: boundedList(input.requestedTools, 12, 100),
    idempotencyKey: input.idempotencyKey || input.jobId || null
  };
  envelope.payloadDigest = digest(canonicalPayload(envelope));
  return envelope;
}

function bounded(value, max, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  if (Buffer.byteLength(text, "utf8") > max) throw new Error(`${name} exceeds ${max} UTF-8 bytes`);
  return text;
}

function boundedList(value, maxItems, maxChars) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`list exceeds ${maxItems} items`);
  return value.map((item) => bounded(item, maxChars, "list item"));
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function canonicalPayload(envelope) {
  const { payloadDigest, idempotencyKey, ...rest } = envelope;
  return stable(rest);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

module.exports = { compileTask, bounded, boundedList, clamp, canonicalPayload, digest };
