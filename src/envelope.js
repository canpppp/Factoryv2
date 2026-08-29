"use strict";

const crypto = require("node:crypto");
const policy = require("./policy");

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createEnvelope({ goal, repo, trustDomain = "jarvis", allowedAuthorityClasses = [], protectedClasses = [] }) {
  const bound = { goal, repo, trustDomain, allowedAuthorityClasses: [...allowedAuthorityClasses].sort() };
  return {
    id: `env-${hash(bound).slice(0, 16)}`,
    goal,
    repo,
    trustDomain,
    allowedAuthorityClasses,
    protectedClasses,
    boundContractHash: hash(bound)
  };
}

function validateEnvelope(envelope) {
  const requested = new Set(envelope.protectedClasses || []);
  const allowed = new Set(envelope.allowedAuthorityClasses || []);
  const denied = [...requested].filter((x) => !allowed.has(x));
  if (denied.length) return { ok: false, reason: "protected-authority-required", denied };
  return { ok: true };
}

function administrativeUpdateAllowed({ beforeHash, afterHash, field }) {
  const internalFields = new Set(["architectApproval.scopeHash", "summary", "receipt", "progressCheckpoint"]);
  if (!internalFields.has(field)) return { ok: false, reason: "not-internal-administrative-field" };
  if (beforeHash !== afterHash) return { ok: false, reason: "bound-contract-changed" };
  return { ok: true };
}

function protectedClassesForText(text) {
  return policy.protectedImpact(text).classes;
}

module.exports = { createEnvelope, validateEnvelope, administrativeUpdateAllowed, protectedClassesForText, hash };
