"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function createDisposableApp({ root, name = "Candidate", identity = "Candidate" }) {
  const appPath = path.join(root, `${name}.app`);
  const macos = path.join(appPath, "Contents", "MacOS");
  const resources = path.join(appPath, "Contents", "Resources");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  const pidFile = path.join(root, `${name}.pid`);
  const identityFile = path.join(root, `${name}.identity`);
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), plist(name));
  const executable = path.join(macos, name);
  const compiled = compileHelper(executable, { pidFile, identityFile, identity });
  if (!compiled.ok) {
    fs.writeFileSync(executable, [
      "#!/bin/sh",
      `echo $$ > ${quote(pidFile)}`,
      `echo ${quote(identity)} > ${quote(identityFile)}`,
      "sleep 30"
    ].join("\n"));
    fs.chmodSync(executable, 0o755);
  }
  fs.writeFileSync(path.join(appPath, "Contents", "PkgInfo"), "APPL????");
  return { appPath, pidFile, identityFile, identity };
}

function compileHelper(executable, { pidFile, identityFile, identity }) {
  const source = `
#include <stdio.h>
#include <unistd.h>
int main(void) {
  FILE *pid = fopen("${cString(pidFile)}", "w");
  if (pid) { fprintf(pid, "%d\\n", getpid()); fclose(pid); }
  FILE *identity = fopen("${cString(identityFile)}", "w");
  if (identity) { fprintf(identity, "%s\\n", "${cString(identity)}"); fclose(identity); }
  sleep(30);
  return 0;
}
`;
  const r = spawnSync("cc", ["-x", "c", "-", "-o", executable], { input: source, encoding: "utf8" });
  if (r.status === 0) return { ok: true };
  return { ok: false, stderr: r.stderr };
}

function plist(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${xml(name)}</string>
<key>CFBundleIdentifier</key><string>local.factoryv2.${xml(name)}</string>
<key>CFBundleName</key><string>${xml(name)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;
}

function openAndVerifyDisposableApp(app, { timeoutMs = 5000 } = {}) {
  const cmd = buildOpenCommand(app.appPath);
  if (!cmd.ok) return cmd;
  const opened = spawnSync(cmd.command, cmd.args, { encoding: "utf8", timeout: timeoutMs });
  if (opened.status !== 0) {
    return { ok: false, reason: "launchservices-open-failed", stderr: opened.stderr, stdout: opened.stdout };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(app.pidFile) && fs.existsSync(app.identityFile)) {
      const pid = Number(fs.readFileSync(app.pidFile, "utf8").trim());
      const identity = fs.readFileSync(app.identityFile, "utf8").trim();
      if (identity !== app.identity) return { ok: false, reason: "handshake-identity-mismatch", expected: app.identity, actual: identity, pid };
      try {
        process.kill(pid, 0);
        return { ok: true, pid, identity, command: cmd };
      } catch {
        return { ok: false, reason: "managed-pid-not-running", pid };
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return { ok: false, reason: "launchservices-handshake-timeout" };
}

function cleanupPid(pid) {
  if (!pid) return { ok: true, skipped: true };
  try {
    process.kill(pid, "SIGTERM");
    return { ok: true, killedPid: pid };
  } catch (e) {
    return { ok: false, reason: e.message, pid };
  }
}

function quote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function xml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" }[c]));
}

function cString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

module.exports = { buildOpenCommand, verifySpec, createDisposableApp, openAndVerifyDisposableApp, cleanupPid };
