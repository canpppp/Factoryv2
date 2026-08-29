"use strict";

const path = require("node:path");

function buildOpenCommand(appPath) {
  if (!appPath || path.extname(appPath) !== ".app") {
    return { ok: false, reason: "candidate-app-required" };
  }
  return { ok: true, command: "/usr/bin/open", args: ["-n", appPath] };
}

function verifySpec(spec = {}) {
  if (!spec.appPath) return { ok: true, skipped: true };
  const command = buildOpenCommand(spec.appPath);
  if (!command.ok) return command;
  if (spec.expectedIdentity && spec.identity && spec.expectedIdentity !== spec.identity) {
    return { ok: false, reason: "launchservices-identity-mismatch", expected: spec.expectedIdentity, actual: spec.identity };
  }
  return { ok: true, command };
}

module.exports = { buildOpenCommand, verifySpec };
