"use strict";

const PRIORITIES = new Set(["low", "normal", "high"]);

function compileTask(channel, input = {}) {
  return {
    version: 1,
    channel: channel.id,
    objective: bounded(input.objective || input.prompt, 4000, "objective"),
    contextRefs: boundedList(input.contextRefs, 8, 300),
    evidenceRequired: boundedList(input.evidenceRequired, 8, 300),
    readWriteBoundary: input.readWriteBoundary || "read-only",
    doneCondition: bounded(input.doneCondition || "Return a concise evidence-backed result.", 1000, "doneCondition"),
    tokenBudget: clamp(input.tokenBudget, 256, 32000, 4000),
    timeoutMs: clamp(input.timeoutMs, 1000, 30 * 60 * 1000, 5 * 60 * 1000),
    priority: PRIORITIES.has(input.priority) ? input.priority : "normal",
    requestedTools: boundedList(input.requestedTools, 12, 100)
  };
}

function bounded(value, max, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  if (text.length > max) throw new Error(`${name} exceeds ${max} characters`);
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

module.exports = { compileTask, bounded, boundedList, clamp };
