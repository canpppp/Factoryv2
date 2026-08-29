"use strict";

const PROTECTED_AUTHORITY_CLASSES = Object.freeze([
  "capability-policy",
  "turn-authority",
  "canonical-executor-tools-run",
  "confirmation-gate",
  "guest-privacy",
  "model-egress-dlp",
  "speech-authority",
  "durable-state-authority",
  "credential-handling",
  "external-write-permissions",
  "destructive-migrations"
]);

const FORBIDDEN_COMMANDS = Object.freeze([
  { re: /\bgit\s+merge\b/, why: "merge waits for Ship it" },
  { re: /\bgh\s+pr\s+merge\b/, why: "merge waits for Ship it" },
  { re: /\bgit\s+push\b[^|;&]*\s+(?:origin\s+)?(?:HEAD:)?main\b/, why: "main writes are F5 only" },
  { re: /\bdeploy(?:\.sh)?\b/, why: "JARVIS auto-deploy is absent during Factory development" },
  { re: /\bsecurity\s+(?:add|delete|find)-generic-password\b|\bkeychain\b/i, why: "credential access is protected" },
  { re: /\brm\s+-rf\s+\/(?:\s|$)|\brm\s+-rf\s+~(?:\s|$)/, why: "unbounded deletion" }
]);

function commandAllowed(command) {
  const s = String(command || "");
  if (!s.trim()) return { ok: false, reason: "empty-command" };
  for (const f of FORBIDDEN_COMMANDS) {
    if (f.re.test(s)) return { ok: false, reason: "forbidden-command", detail: f.why };
  }
  return { ok: true };
}

function protectedImpact(goalText) {
  const text = String(goalText || "").toLowerCase();
  const hits = PROTECTED_AUTHORITY_CLASSES.filter((c) => text.includes(c.replace(/-/g, " ")));
  return { ok: hits.length === 0, classes: hits };
}

module.exports = { PROTECTED_AUTHORITY_CLASSES, FORBIDDEN_COMMANDS, commandAllowed, protectedImpact };
