"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KINDS = new Set(["invoice-compare", "shopify-snapshot", "campaign-checklist", "file-route", "scheduled-notification"]);

function canRun(job) {
  return !!job?.deterministic && KINDS.has(job.deterministic.kind);
}

function run(job) {
  if (!canRun(job)) return { ok: false, reason: "not-deterministic" };
  const spec = job.deterministic;
  if (spec.kind === "invoice-compare") return compareRecords(spec.records || []);
  if (spec.kind === "campaign-checklist") return checklist(spec.items || []);
  if (spec.kind === "file-route") return routeFiles(spec);
  if (spec.kind === "shopify-snapshot") return { ok: true, kind: spec.kind, snapshot: spec.data || {}, generatedAt: new Date().toISOString() };
  return { ok: true, kind: spec.kind, notification: String(spec.message || "") };
}

function compareRecords(records) {
  const byInvoice = new Map();
  for (const record of records) {
    const current = byInvoice.get(record.invoiceId) || [];
    current.push(Number(record.amount || 0));
    byInvoice.set(record.invoiceId, current);
  }
  const mismatches = [...byInvoice].filter(([, amounts]) => new Set(amounts).size > 1).map(([invoiceId, amounts]) => ({ invoiceId, amounts }));
  return { ok: true, kind: "invoice-compare", records: records.length, mismatches };
}

function checklist(items) {
  const missing = items.filter((item) => !item.complete).map((item) => item.name);
  return { ok: missing.length === 0, kind: "campaign-checklist", missing };
}

function routeFiles(spec) {
  const source = path.resolve(spec.source || ".");
  if (!fs.existsSync(source)) return { ok: false, kind: "file-route", reason: "source-missing" };
  return { ok: true, kind: "file-route", source, destination: path.resolve(spec.destination || "."), plannedOnly: true };
}

module.exports = { KINDS, canRun, run, compareRecords, checklist };
