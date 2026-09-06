"use strict";

function verifyWorkerResult({ channelId, job, receipt, contextManifest = null } = {}) {
  const parsed = parseResult(receipt && receipt.finalResponse);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!value.channelId) return fail("CHANNEL_ID_MISSING", "worker result did not acknowledge the channel identity");
  if (!value.jobId) return fail("JOB_ID_MISSING", "worker result did not acknowledge the job identity");
  if (value.channelId !== channelId) return fail("WRONG_CHANNEL", "worker result belongs to another channel");
  if (value.jobId !== job.id) return fail("WRONG_JOB", "worker result belongs to another job");
  if (value.engine && receipt.engine && value.engine !== receipt.engine) return fail("WRONG_ENGINE", "worker result belongs to another engine");
  if (value.refusal || value.unavailable) return fail("WORKER_UNAVAILABLE", "worker reported refusal or unavailable source");
  if (value.done !== true) return fail("OBJECTIVE_UNVERIFIED", "worker did not mark the objective done");
  const summary = clean(value.summary || value.finding, 1000);
  if (!summary) return fail("SUMMARY_MISSING", "verified completion requires a summary");
  const evidence = Array.isArray(value.evidence) ? value.evidence.map((item) => clean(item.ref || item, 240)).filter(Boolean) : [];
  const required = Array.isArray(job.envelope?.evidenceRequired) ? job.envelope.evidenceRequired : [];
  const missing = required.filter((ref) => !evidence.includes(ref));
  if (missing.length) return fail("EVIDENCE_MISSING", "worker result is missing required evidence", { missing });
  if (contextManifest && !value.contextManifestSha256) return fail("CONTEXT_MANIFEST_UNACKED", "worker did not acknowledge resolved context manifest");
  if (contextManifest && value.contextManifestSha256 !== contextManifest.sha256) {
    return fail("CONTEXT_MANIFEST_MISMATCH", "worker acknowledged a different context manifest");
  }
  return { ok: true, verified: true, summary, evidence, structured: value };
}

function parseResult(text) {
  const raw = String(text || "").trim();
  if (!raw) return fail("MALFORMED_RESPONSE", "worker returned no final response");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fail("MALFORMED_RESPONSE", "worker response is not structured JSON");
    try { value = JSON.parse(match[0]); } catch { return fail("MALFORMED_RESPONSE", "worker response contains malformed JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("MALFORMED_RESPONSE", "worker result is not an object");
  return { ok: true, value };
}

function clean(value, max) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function fail(code, reason, extra = {}) {
  return { ok: false, verified: false, code, reason, ...extra };
}

module.exports = { verifyWorkerResult, parseResult };
