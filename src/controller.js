"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const journal = require("./journal");
const lease = require("./lease");
const policy = require("./policy");
const git = require("./git");
const candidate = require("./candidate");
const releaseTrain = require("./release-train");
const envelope = require("./envelope");

const MAX_REPAIRS = 2;

function slug(s) {
  return String(s || "goal").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "goal";
}

function createController({ root, adapter }) {
  if (!root) throw new Error("controller needs root");
  if (!adapter) throw new Error("controller needs adapter");

  const emit = (event) => journal.append(root, event);
  const setMissionState = (mission, to, extra = {}) => emit({ type: "mission.state", missionId: mission.id, from: mission.state, to, ...extra });
  const setField = (mission, field, value) => emit({ type: "mission.field", missionId: mission.id, field, value });

  function enqueueGoal({ goal, repo, missionOverrides = {} }) {
    const impact = policy.protectedImpact(goal);
    const id = `goal-${Date.now()}-${slug(goal)}`;
    const env = envelope.createEnvelope({
      goal,
      repo,
      trustDomain: missionOverrides.trustDomain || "jarvis",
      allowedAuthorityClasses: missionOverrides.allowedAuthorityClasses || [],
      protectedClasses: impact.classes
    });
    const envCheck = envelope.validateEnvelope(env);
    emit({ type: "goal.enqueued", goalId: id, goal: { text: goal, repo, envelope: env, missionOverrides, protectedClasses: impact.classes } });
    if (!envCheck.ok) emit({ type: "goal.state", goalId: id, from: "queued", to: "blocked", blocker: `protected classes: ${envCheck.denied.join(", ")}` });
    return { id, text: goal, repo };
  }

  function architect(goal) {
    const missionId = `${goal.id.replace(/^goal-/, "mission-")}`;
    const branch = `factory/${missionId.slice(0, 64)}`;
    const mission = {
      goalId: goal.id,
      title: "Factory-generated mission",
      repo: goal.repo,
      branch,
      ownedFiles: ["src/**", "README.md", "docs/**", "tests/**"],
      verifyCommands: ["npm test"],
      acceptanceCommands: [],
      trustDomain: (goal.envelope && goal.envelope.trustDomain) || "jarvis",
      envelope: goal.envelope,
      maxRepairRounds: MAX_REPAIRS,
      attempts: 0,
      repairRounds: 0,
      ...(goal.missionOverrides || {})
    };
    emit({ type: "architect.started", goalId: goal.id });
    emit({ type: "mission.created", goalId: goal.id, missionId, mission });
    emit({ type: "goal.state", goalId: goal.id, from: goal.state, to: "running" });
    return missionId;
  }

  async function build(mission) {
    const worktree = mission.worktree || git.ensureWorktree(root, mission);
    if (!mission.worktree) setField(mission, "worktree", worktree);
    setMissionState(mission, "building");
    const worker = mission.workerThreadId
      ? adapter.resumeThread(mission.workerThreadId, { role: "worker", cwd: worktree, readOnly: false })
      : adapter.startThread({ role: "worker", cwd: worktree, readOnly: false });
    await worker.run(workerPrompt(mission), {
      onThreadId: (id) => {
        if (id && id !== mission.workerThreadId) setField(mission, "workerThreadId", id);
      }
    });
    setField(mission, "attempts", (mission.attempts || 0) + 1);
    const c = git.commitAll(worktree, `${mission.title}\n\nMission: ${mission.id}`);
    if (!c.ok) {
      setMissionState(mission, "blocked", { blocker: c.reason });
      return;
    }
    setField(mission, "commit", c.sha);
    setMissionState(mission, "verifying");
  }

  function verify(mission) {
    const results = [];
    for (const command of mission.verifyCommands || []) {
      const allowed = policy.commandAllowed(command);
      if (!allowed.ok) {
        results.push({ command, passed: false, refused: true, reason: allowed.detail || allowed.reason });
        continue;
      }
      const r = spawnSync("/bin/bash", ["-lc", command], { cwd: mission.worktree, encoding: "utf8", timeout: 120000 });
      results.push({ command, passed: r.status === 0, exitCode: r.status, output: `${r.stdout || ""}${r.stderr || ""}`.slice(-2000) });
    }
    setField(mission, "lastGateResults", results);
    emit({ type: "verification.finished", missionId: mission.id, results });
    if (results.some((r) => !r.passed)) return queueRepair(mission, results.map((r) => `gate failed: ${r.command}`));
    setMissionState(mission, "reviewing");
  }

  async function review(mission) {
    const reviewer = mission.reviewerThreadId
      ? adapter.resumeThread(mission.reviewerThreadId, { role: "reviewer", cwd: mission.worktree, readOnly: true })
      : adapter.startThread({ role: "reviewer", cwd: mission.worktree, readOnly: true });
    const res = await reviewer.run(reviewPrompt(mission), {
      onThreadId: (id) => {
        if (id && id !== mission.reviewerThreadId) setField(mission, "reviewerThreadId", id);
      }
    });
    const verdict = parseReview(res.finalResponse);
    emit({ type: "review.finished", missionId: mission.id, verdict });
    if (mission.workerThreadId && mission.workerThreadId === mission.reviewerThreadId) {
      return queueRepair(mission, ["reviewer was not independent"]);
    }
    if (verdict.verdict !== "approve") return queueRepair(mission, verdict.findings);
    setMissionState(mission, "integrating");
  }

  function integrate(mission) {
    const result = releaseTrain.integrate(mission);
    setField(mission, "integration", result);
    emit({ type: "integration.finished", missionId: mission.id, result });
    setMissionState(mission, mission.candidateSpec ? "candidate" : "accepting");
  }

  function createCandidate(mission) {
    const cand = candidate.createCandidate(journal.paths(root).root, mission);
    const launch = candidate.launchCandidate(cand);
    const verified = candidate.verifyLaunch({ candidate: cand, launch });
    const cleanup = candidate.cleanupExactPid(launch);
    const result = {
      manifestPath: cand.manifestPath,
      candidateId: cand.candidateId,
      launch: { launched: launch.launched, pid: launch.pid || null },
      verified,
      cleanup
    };
    setField(mission, "candidate", result);
    emit({ type: "candidate.verified", missionId: mission.id, result });
    if (!verified.ok || !cleanup.ok) setMissionState(mission, "blocked", { blocker: verified.reason || cleanup.reason });
    else setMissionState(mission, "accepting");
  }

  function accept(mission) {
    const commands = mission.acceptanceCommands && mission.acceptanceCommands.length
      ? mission.acceptanceCommands
      : mission.verifyCommands;
    const results = commands.map((command) => {
      const allowed = policy.commandAllowed(command);
      if (!allowed.ok) return { command, passed: false, refused: true, reason: allowed.detail || allowed.reason };
      const r = spawnSync("/bin/bash", ["-lc", command], { cwd: mission.worktree, encoding: "utf8", timeout: 120000 });
      return { command, passed: r.status === 0, exitCode: r.status, output: `${r.stdout || ""}${r.stderr || ""}`.slice(-2000) };
    });
    setField(mission, "acceptance", results);
    emit({ type: "acceptance.finished", missionId: mission.id, results });
    if (results.some((r) => !r.passed)) return queueRepair(mission, results.map((r) => `acceptance failed: ${r.command}`));
    const rel = mission.releasePolicy
      ? releaseTrain.release(mission, { shipIt: !!mission.releasePolicy.shipIt })
      : { ok: true, released: false, reason: "release-not-requested" };
    setField(mission, "release", rel);
    emit({ type: "release.evaluated", missionId: mission.id, result: rel });
    if (!rel.ok && mission.releasePolicy && mission.releasePolicy.required) {
      setMissionState(mission, "blocked", { blocker: rel.reason });
      return;
    }
    setMissionState(mission, "ready_for_human_check");
    emit({ type: "receipt", missionId: mission.id, status: "READY_FOR_HUMAN_CHECK", summary: renderReceipt(mission) });
  }

  function queueRepair(mission, findings) {
    const rounds = mission.repairRounds || 0;
    setField(mission, "lastFindings", findings);
    if (rounds >= (mission.maxRepairRounds || MAX_REPAIRS)) {
      setMissionState(mission, "blocked", { blocker: `repair budget exhausted: ${findings.join("; ")}` });
      return;
    }
    setField(mission, "repairRounds", rounds + 1);
    emit({ type: "repair.queued", missionId: mission.id, findings });
    setMissionState(mission, "repair");
  }

  async function step() {
    let state = journal.load(root);
    if (!state.ok) return { progressed: false, summary: `blocked: ${state.reason}` };
    const queuedGoal = [...state.goals.values()].find((g) => g.state === "queued");
    if (queuedGoal) {
      architect(queuedGoal);
      return { progressed: true, summary: "architected goal" };
    }
    state = journal.load(root);
    const mission = [...state.missions.values()].find((m) => ["queued", "building", "repair", "verifying", "reviewing", "integrating", "candidate", "accepting"].includes(m.state));
    if (!mission) return { progressed: false, summary: "idle" };
    try {
      if (["queued", "building", "repair"].includes(mission.state)) await build(mission);
      else if (mission.state === "verifying") verify(mission);
      else if (mission.state === "reviewing") await review(mission);
      else if (mission.state === "integrating") integrate(mission);
      else if (mission.state === "candidate") createCandidate(mission);
      else if (mission.state === "accepting") accept(mission);
      journal.writeSnapshot(root);
      return { progressed: true, summary: `advanced ${mission.id}` };
    } catch (e) {
      if (e.code === "INTERRUPTED") {
        emit({ type: "worker.interrupted", missionId: mission.id, message: e.message });
        journal.writeSnapshot(root);
        return { progressed: true, interrupted: true, summary: `interrupted ${mission.id}; restart will resume` };
      }
      setMissionState(mission, "blocked", { blocker: e.message });
      return { progressed: true, summary: `blocked ${mission.id}: ${e.message}` };
    }
  }

  async function run({ maxSteps = 100 } = {}) {
    return lease.withLease(root, async () => {
      let summary = "idle";
      for (let i = 0; i < maxSteps; i++) {
        const r = await step();
        summary = r.summary;
        if (r.interrupted || !r.progressed) break;
      }
      return { ok: true, summary };
    });
  }

  return { enqueueGoal, run, step };
}

function workerPrompt(mission) {
  const findings = (mission.lastFindings || []).map((f) => `- ${f}`).join("\n");
  return [
    `MISSION ${mission.id}`,
    `Goal: ${mission.title}`,
    `Owned files: ${mission.ownedFiles.join(", ")}`,
    findings ? `Repair findings:\n${findings}` : "Initial implementation."
  ].join("\n");
}

function reviewPrompt(mission) {
  return [
    `REVIEW ${mission.id}`,
    "You are independent and read-only.",
    `Gate results: ${JSON.stringify(mission.lastGateResults || [])}`,
    "Return JSON: {\"verdict\":\"approve|reject\",\"findings\":[\"...\"],\"summary\":\"...\"}"
  ].join("\n");
}

function parseReview(text) {
  try {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : "{}");
    return {
      verdict: j.verdict === "approve" ? "approve" : "reject",
      findings: Array.isArray(j.findings) && j.findings.length ? j.findings.map(String) : (j.verdict === "approve" ? [] : ["reviewer rejected without findings"]),
      summary: String(j.summary || "")
    };
  } catch {
    return { verdict: "reject", findings: ["reviewer response was not valid JSON"], summary: "unparseable" };
  }
}

function renderReceipt(mission) {
  const gates = (mission.lastGateResults || []).map((g) => `${g.passed ? "PASS" : "FAIL"} ${g.command}`).join("; ");
  const acceptance = (mission.acceptance || []).map((g) => `${g.passed ? "PASS" : "FAIL"} ${g.command}`).join("; ");
  return `${mission.id}: gates=[${gates}] acceptance=[${acceptance}]. Human app check required.`;
}

module.exports = { createController, parseReview, workerPrompt, reviewPrompt };
