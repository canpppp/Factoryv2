#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { createController } = require("../src/controller");
const journal = require("../src/journal");
const { fakeAdapter } = require("../src/fake-agent");

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : dflt;
};
const root = path.resolve(flag("root", ".factoryv2"));

function die(msg) {
  console.error(`factoryv2: ${msg}`);
  process.exit(1);
}

async function main() {
  if (cmd === "init") {
    const p = journal.ensure(root);
    console.log(`state root  ${p.root}`);
    console.log(`journal     ${p.journal}`);
    return;
  }
  if (cmd === "goal") {
    const text = argv.slice(1).filter((x) => !x.startsWith("--")).join(" ").trim();
    if (!text) die("usage: factoryv2 goal <goal text> [--repo <path>]");
    const repo = flag("repo", null);
    if (!repo) die("--repo is required for F0/F1");
    const controller = createController({ root, adapter: fakeAdapter({}) });
    const goal = controller.enqueueGoal({ goal: text, repo: path.resolve(repo) });
    console.log(`queued ${goal.id}`);
    return;
  }
  if (cmd === "run") {
    const controller = createController({ root, adapter: fakeAdapter({}) });
    const result = await controller.run({ maxSteps: Number(flag("max-steps", 100)) });
    console.log(result.summary);
    return;
  }
  if (cmd === "status") {
    const state = journal.load(root);
    console.log(journal.renderStatus(state));
    return;
  }
  die("commands: init, goal, run, status");
}

main().catch((e) => die(e.stack || e.message));
