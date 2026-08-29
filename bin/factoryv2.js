#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { createController } = require("../src/controller");
const journal = require("../src/journal");
const report = require("../src/report");
const audit = require("../src/audit");
const { fakeAdapter } = require("../src/fake-agent");

const argv = process.argv.slice(2);
const FLAGS_WITH_VALUES = new Set(["--root", "--repo", "--max-steps"]);
function positionals() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (FLAGS_WITH_VALUES.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith("--")) continue;
    out.push(argv[i]);
  }
  return out;
}
const pos = positionals();
const cmd = pos[0];
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
    const text = pos.slice(1).join(" ").trim();
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
  if (cmd === "inspect") {
    const id = pos[1];
    if (!id) die("usage: factoryv2 inspect <mission-id>");
    const state = journal.load(root);
    const r = report.missionReport(state, id);
    if (!r.ok) die(r.reason);
    console.log(r.text);
    return;
  }
  if (cmd === "pause") {
    journal.ensure(root);
    fs.writeFileSync(path.join(root, "PAUSED"), new Date().toISOString());
    journal.append(root, { type: "controller.paused" });
    console.log("paused");
    return;
  }
  if (cmd === "resume") {
    fs.rmSync(path.join(root, "PAUSED"), { force: true });
    journal.append(root, { type: "controller.resumed" });
    console.log("resumed");
    return;
  }
  if (cmd === "decisions") {
    const state = journal.load(root);
    const blockedGoals = [...state.goals.values()].filter((g) => g.state === "blocked");
    const blockedMissions = [...state.missions.values()].filter((m) => m.state === "blocked");
    if (!blockedGoals.length && !blockedMissions.length) console.log("no decisions");
    for (const g of blockedGoals) console.log(`HUMAN_DECISION_REQUIRED goal ${g.id}`);
    for (const m of blockedMissions) console.log(`HUMAN_DECISION_REQUIRED mission ${m.id}: ${m.blocker || "blocked"}`);
    return;
  }
  if (cmd === "accept") {
    const id = pos[1];
    if (!id) die("usage: factoryv2 accept <mission-id>");
    journal.append(root, { type: "human.accepted", missionId: id });
    console.log(`accepted ${id}`);
    return;
  }
  if (cmd === "reject") {
    const id = pos[1];
    const feedback = pos.slice(2).join(" ").trim();
    if (!id || !feedback) die("usage: factoryv2 reject <mission-id> <feedback>");
    journal.append(root, { type: "human.rejected", missionId: id, feedback });
    journal.append(root, { type: "repair.queued", missionId: id, findings: [`human feedback: ${feedback}`] });
    journal.append(root, { type: "mission.state", missionId: id, from: "ready_for_human_check", to: "repair" });
    console.log(`repair queued ${id}`);
    return;
  }
  if (cmd === "ship") {
    const id = pos[1];
    if (!id) die("usage: factoryv2 ship <mission-id>");
    journal.append(root, { type: "human.ship_it", missionId: id });
    console.log(`ship-it recorded ${id}`);
    return;
  }
  if (cmd === "candidate" && pos[1] === "open") {
    const id = pos[2];
    if (!id) die("usage: factoryv2 candidate open <mission-id>");
    const state = journal.load(root);
    const mission = state.missions.get(id);
    if (!mission || !mission.candidate) die("candidate not found");
    console.log(mission.candidate.manifestPath);
    return;
  }
  if (cmd === "audit") {
    console.log(audit.renderProductionAudit());
    return;
  }
  die("commands: init, goal, run, status, inspect, pause, resume, decisions, accept, reject, ship, candidate open, audit");
}

main().catch((e) => die(e.stack || e.message));
