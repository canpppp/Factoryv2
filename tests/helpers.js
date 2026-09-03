"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const temps = [];

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}

function cleanup() {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
}

process.on("exit", cleanup);

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return String(r.stdout || "").trim();
}

function makeBugRepo() {
  const dir = tmp("factoryv2-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "factoryv2@test.invalid"]);
  git(dir, ["config", "user.name", "Factory V2 Test"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node tests/add.test.js" } }, null, 2));
  fs.writeFileSync(path.join(dir, "src/add.js"), "exports.add = (a, b) => a - b;\n");
  fs.writeFileSync(path.join(dir, "tests/add.test.js"), "const assert = require('node:assert'); const { add } = require('../src/add'); assert.strictEqual(add(2, 3), 5);\n");
  fs.writeFileSync(path.join(dir, "README.md"), "Bug repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial bug"]);
  return dir;
}

function makeRuntimeRepo() {
  const dir = makeBugRepo();
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(dir, "runtime/ui.js"), "module.exports = 'candidate-ui';\n");
  fs.writeFileSync(path.join(dir, "runtime/agent.js"), "module.exports = 'candidate-agent';\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "add candidate runtimes"]);
  return dir;
}

function cloneRepo(source) {
  const dir = tmp("factoryv2-jarvis-");
  fs.rmSync(dir, { recursive: true, force: true });
  const r = spawnSync("git", ["clone", "-q", "--no-hardlinks", source, dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git clone: ${r.stderr || r.stdout}`);
  git(dir, ["config", "user.email", "factoryv2@test.invalid"]);
  git(dir, ["config", "user.name", "Factory V2 Test"]);
  return dir;
}

function makeJarvisDocsTestRepo(source) {
  const dir = tmp("factoryv2-jarvis-lite-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "factoryv2@test.invalid"]);
  git(dir, ["config", "user.name", "Factory V2 Test"]);
  for (const rel of ["AGENTS.md", "docs/STATUS.md"]) {
    const src = path.join(source, rel);
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.existsSync(src) ? fs.readFileSync(src, "utf8") : `${rel}\n`);
  }
  fs.mkdirSync(path.join(dir, "agent/tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent/tests/README.md"), "JARVIS test fixtures live here.\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed jarvis docs test context"]);
  return dir;
}

function makeChannelDefinitions() {
  const dir = tmp("factoryv2-channel-project-");
  fs.writeFileSync(path.join(dir, ".factory-channel.json"), JSON.stringify({ version: 1 }));
  const ids = ["kaylas-store", "store-two", "quality-check", "facebook-product-launches", "invoice-audit", "jarvis-development"];
  const definitions = ids.map((id) => ({
    id,
    name: id,
    cwd: dir,
    engine: ["quality-check", "invoice-audit", "jarvis-development"].includes(id) ? "codex" : "claude",
    modelPolicy: { kind: id === "invoice-audit" ? "inventory" : "implementation" },
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    readWriteProfile: "read-only",
    writeAuthority: "none",
    projectIdentity: { marker: ".factory-channel.json" },
    capsule: `Test capsule for ${id}.`
  }));
  const definitionsPath = path.join(dir, "channels.json");
  fs.writeFileSync(definitionsPath, JSON.stringify(definitions));
  return { dir, definitionsPath };
}

module.exports = { tmp, cleanup, git, makeBugRepo, makeRuntimeRepo, cloneRepo, makeJarvisDocsTestRepo, makeChannelDefinitions };
