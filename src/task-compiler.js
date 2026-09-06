"use strict";

const { createHash } = require("node:crypto");

const PRIORITIES = new Set(["low", "normal", "high"]);

function compileTask(channel, input = {}) {
  for (const key of ["workerPolicy", "command", "executable", "env", "auth", "stateRoot", "runtimeReadRoots", "resumeProfileDigest"]) {
    if (Object.hasOwn(input, key)) throw Object.assign(new Error(`jobs cannot override worker ${key}`), { code: "POLICY_DENIED" });
  }
  const tokenBudget = clamp(input.tokenBudget, 256, 32000, 4000);
  const timeoutMs = clamp(input.timeoutMs, 1000, 30 * 60 * 1000, 5 * 60 * 1000);
  const profile = acceptanceProfile(input.acceptanceProfile, input.doneCondition);
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
    acceptanceProfile: profile,
    acceptanceRequired: input.acceptanceProfile != null || needsAcceptance(input.doneCondition, input.evidenceRequired),
    tokenBudget,
    timeoutMs,
    budgets: { tokenBudget, timeoutMs },
    priority: PRIORITIES.has(input.priority) ? input.priority : "normal",
    requestedTools: boundedList(input.requestedTools, 12, 100),
    ...(input.readRoots == null ? {} : { readRoots: boundedList(input.readRoots, 12, 1000) }),
    ...(input.writeRoots == null ? {} : { writeRoots: boundedList(input.writeRoots, 12, 1000) }),
    ...(input.outputLimits == null ? {} : { outputLimits: { ...input.outputLimits } }),
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

function acceptanceProfile(value, doneCondition = "") {
  if (value == null) {
    const predicate = predicateFromDoneCondition(doneCondition);
    return predicate ? [predicate] : [];
  }
  if (!Array.isArray(value) || value.length > 8) throw new Error("acceptanceProfile exceeds 8 items");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("acceptanceProfile item must be an object");
    if (item.type !== "fieldEquals") throw new Error("unsupported acceptanceProfile predicate");
    return {
      type: "fieldEquals",
      ref: bounded(item.ref, 300, "acceptance ref"),
      field: bounded(item.field, 100, "acceptance field"),
      equals: bounded(String(item.equals), 300, "acceptance equals")
    };
  });
}

function predicateFromDoneCondition(doneCondition) {
  const text = String(doneCondition || "");
  const match = text.match(/\b([A-Za-z][A-Za-z0-9_-]{0,80})\b\s+(?:equals|=|is)\s+([A-Za-z0-9_.-]+)/i);
  if (!match) return null;
  return { type: "fieldEquals", ref: null, field: match[1], equals: match[2] };
}

function needsAcceptance(doneCondition, evidenceRequired) {
  return !!String(doneCondition || "").trim()
    && !/^Return a concise evidence-backed result\.$/.test(String(doneCondition).trim())
    && Array.isArray(evidenceRequired)
    && evidenceRequired.length > 0;
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

module.exports = { compileTask, bounded, boundedList, clamp, acceptanceProfile, canonicalPayload, digest };
