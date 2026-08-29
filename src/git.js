"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const journal = require("./journal");

function git(cwd, args, opts = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return { ok: r.status === 0, status: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") };
}

function ensureWorktree(root, mission) {
  const p = journal.ensure(root);
  const dir = path.join(p.worktrees, mission.id);
  if (fs.existsSync(dir)) return dir;
  const branch = mission.branch;
  git(mission.repo, ["worktree", "add", "-q", "-b", branch, dir, "HEAD"]);
  return dir;
}

function changedFiles(dir, base = "HEAD~1") {
  const r = git(dir, ["diff", "--name-only", base, "HEAD"], { allowFail: true });
  if (!r.ok) return [];
  return r.out.split("\n").map((x) => x.trim()).filter(Boolean);
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  const diff = git(dir, ["diff", "--cached", "--quiet"], { allowFail: true });
  if (diff.status === 0) return { ok: false, reason: "nothing-to-commit" };
  git(dir, ["commit", "-q", "-m", message]);
  return { ok: true, sha: git(dir, ["rev-parse", "HEAD"]).out.trim() };
}

function file(pathname) {
  return fs.readFileSync(pathname, "utf8");
}

module.exports = { git, ensureWorktree, changedFiles, commitAll, file };
