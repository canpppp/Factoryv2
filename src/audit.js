"use strict";

const ITEMS = Object.freeze([
  ["A", "one-command goal execution", "proved"],
  ["B", "goal decomposition", "proved"],
  ["C", "persistent autonomous execution", "partial"],
  ["D", "worker recovery", "proved"],
  ["E", "reviewer independence", "proved"],
  ["F", "authoritative evidence", "proved"],
  ["G", "repair budgets", "proved"],
  ["H", "administrative self-management", "proved"],
  ["I", "protected architecture boundary", "proved"],
  ["J", "candidate system", "proved"],
  ["K", "dependency closure", "proved"],
  ["L", "LaunchServices proof", "partial"],
  ["M", "automated product acceptance", "partial"],
  ["N", "READY_FOR_HUMAN_CHECK", "proved"],
  ["O", "human rejection loop", "proved"],
  ["P", "Ship-it release train", "partial"],
  ["Q", "long autonomous endurance", "proved"]
]);

function productionAudit() {
  return ITEMS.map(([id, title, status]) => ({ id, title, status }));
}

function renderProductionAudit() {
  return productionAudit().map((item) => `${item.id}. ${item.status.toUpperCase()} ${item.title}`).join("\n");
}

function remainingLimitations() {
  return productionAudit().filter((item) => item.status !== "proved");
}

module.exports = { productionAudit, renderProductionAudit, remainingLimitations };
