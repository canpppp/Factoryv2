"use strict";

const journal = require("./journal");

function proposeImprovement(root, outcome = {}) {
  if (!outcome.success || !outcome.complex) return { proposed: false, reason: "not-a-complex-success" };
  const kind = outcome.skillName ? "existing-skill-update" : (Number(outcome.repetitions) >= 2 ? "new-skill-proposal" : "no-persistent-skill");
  if (kind === "no-persistent-skill") return { proposed: false, reason: kind };
  const proposal = {
    type: "skill.improvement.proposed",
    proposalId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind,
    skillName: outcome.skillName || null,
    title: bounded(outcome.title || "Reusable procedure improvement", 160),
    procedure: bounded(outcome.procedure, 4000),
    evidence: Array.isArray(outcome.evidence) ? outcome.evidence.slice(0, 8).map((item) => bounded(item, 400)) : [],
    expandsAuthority: !!outcome.expandsAuthority,
    activation: "proposed-only",
    requiresApproval: !!outcome.expandsAuthority
  };
  return { proposed: true, event: journal.append(root, proposal) };
}

function bounded(value, limit) {
  const text = String(value || "").trim();
  if (!text) throw new Error("skill proposal content is required");
  if (text.length > limit) throw new Error(`skill proposal exceeds ${limit} characters`);
  return text;
}

module.exports = { proposeImprovement };
