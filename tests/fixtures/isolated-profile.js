"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Disposable pinned protocol program: the production sandbox still encloses it.
function fixtureProfile(source, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-worker-fixture-"));
  const command = path.join(root, "fixture-cli");
  const content = fs.readFileSync(source, "utf8").replace(/^#![^\n]*\n/, "");
  fs.writeFileSync(command, `#!${fs.realpathSync(process.execPath)}\n${content}`, { mode: 0o700 });
  const executable = fs.realpathSync(process.execPath);
  const sha = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  const entrypointSha256 = createHash("sha256").update(fs.readFileSync(command)).digest("hex");
  const stateRoot = path.join(root, "state"); fs.mkdirSync(stateRoot, { mode: 0o700 });
  return { command: executable, workerPolicy: { entrypoint: command, entrypointSha256, executableSha256: sha, protocolFixtureSha256: sha, auth: { mode: "none" }, stateRoot, runtimeReadRoots: [], tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"], ...overrides } };
}

module.exports = { fixtureProfile };
