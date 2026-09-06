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
const jarvisAcceptance = require("./jarvis-acceptance");
const modelRouter = require("./model-router");
const tokenGovernor = require("./token-governor");
const { randomUUID } = require("node:crypto");
const { createAdapter } = require("./adapters");
const rolePolicy = require("./controller-policy");

const MAX_REPAIRS = 2;

function slug(s) {
  return String(s || "goal").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "goal";
}

function planGoal(goal) {
  rolePolicy.assertMissionInput(goal.missionOverrides);
  const templates = Array.isArray(goal.missionOverrides?.missions) && goal.missionOverrides.missions.length
    ? goal.missionOverrides.missions : [goal.missionOverrides || {}];
  return templates.map((template, index) => {
    const missionId = template.id || `${goal.id.replace(/^goal-/, "mission-")}-${index + 1}`;
    const mission = {
      goalId: goal.id,
      title: "Factory-generated mission",
      repo: goal.repo,
      branch: template.branch || `factory/${missionId.slice(0, 64)}`,
      ownedFiles: ["src/**", "README.md", "docs/**", "tests/**"],
      verifyCommands: ["npm test"],
      acceptanceCommands: [],
      trustDomain: (goal.envelope && goal.envelope.trustDomain) || "jarvis",
      envelope: goal.envelope,
      maxRepairRounds: MAX_REPAIRS,
      attempts: 0,
      repairRounds: 0,
      replacements: 0,
      ...template
    };
    delete mission.missions;
    return { missionId, mission };
  });
}

function createController({ root, adapter, adapterFactory = createAdapter, rolePolicies, rolePoliciesPath }) {
  if (!root) throw new Error("controller needs root");
  const trustedPolicies = rolePolicy.loadRolePolicies({ rolePolicies, rolePoliciesPath });

  const emit = (event) => journal.append(root, event);
  const setMissionState = (mission, to, extra = {}) => {
    emit({ type: "mission.state", missionId: mission.id, from: mission.state, to, ...extra });
    mission.state = to;
    if (extra.blocker !== undefined) mission.blocker = extra.blocker;
  };
  const setField = (mission, field, value) => {
    emit({ type: "mission.field", missionId: mission.id, field, value });
    mission[field] = value;
  };

  function enqueueGoal({ goal, repo, missionOverrides = {} }) {
    rolePolicy.assertMissionInput(missionOverrides);
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
    const plan = planGoal(goal);
    emit({ type: "architect.started", goalId: goal.id });
    plan.forEach(({ missionId, mission }) => {
      emit({ type: "mission.created", goalId: goal.id, missionId, mission });
    });
    emit({ type: "goal.state", goalId: goal.id, from: goal.state, to: "running" });
  }

  async function build(mission) {
    rolePolicy.requireRolePolicies(trustedPolicies);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(mission.id)) throw Object.assign(new Error("invalid mission identity"), { code: "POLICY_DENIED" });
    const worktree = mission.worktree || git.ensureWorktree(root, mission);
    if (!mission.worktree) setField(mission, "worktree", worktree);
    const prompt = workerPrompt(mission);
    const result = await runRole(mission, "worker", prompt);
    if (result.finalResponse && /MALFORMED_WORKER_RESPONSE/.test(result.finalResponse)) {
      const e = new Error("malformed worker response");
      e.code = "MALFORMED_WORKER_RESPONSE";
      throw e;
    }
    setField(mission, "attempts", (mission.attempts || 0) + 1);
    const c = git.commitAll(worktree, `${mission.title}\n\nMission: ${mission.id}`);
    if (!c.ok) {
      setMissionState(mission, "blocked", { blocker: c.reason });
      return;
    }
    setField(mission, "commit", c.sha);
    setMissionState(mission, "verifying");
  }

  function session(mission, role, record) {
    emit({ type: "mission.role.session", missionId: mission.id, role, record });
    mission.roleSessions = { ...mission.roleSessions, [role]: record };
    mission[`${role}ThreadId`] = record.sessionId;
  }

  function resetRole(mission, role, reason) {
    const previous = mission.roleSessions?.[role];
    if (previous && previous.status !== "settled") throw Object.assign(new Error("prior role execution requires reconciliation"), { code: "RECONCILIATION_REQUIRED" });
    emit({ type: `${role}.replaced`, missionId: mission.id, oldThreadId: mission[`${role}ThreadId`], reason });
    setField(mission, "replacements", (mission.replacements || 0) + 1);
    session(mission, role, { ...previous, version: 1, missionId: mission.id, role, sessionId: null, profileDigest: null, status: "settled", terminalCause: reason });
  }

  function checkSettled(mission) {
    for (const record of Object.values(mission.roleSessions || {})) {
      if (record.terminalCause === "CLEANUP_FAILED") throw Object.assign(new Error("prior role cleanup failed"), { code: "CLEANUP_FAILED" });
      if (record.status !== "settled") throw Object.assign(new Error("prior role execution requires reconciliation"), { code: "RECONCILIATION_REQUIRED" });
    }
    for (const role of rolePolicy.roles) {
      if (mission[`${role}ThreadId`] && !mission.roleSessions?.[role] && !legacySettled(mission, role)) {
        throw Object.assign(new Error("legacy role session requires reconciliation"), { code: "RECONCILIATION_REQUIRED" });
      }
    }
  }

  function legacySettled(mission, role) {
    const last = journal.load(root).events.findLast((event) => event.missionId === mission.id && (
      (event.type === "agent.receipt" && event.role === role)
      || event.type === `${role}.interrupted`
      || (event.type === "mission.state" && event.to === (role === "worker" ? "building" : "reviewing"))));
    return last?.type === "agent.receipt" && last.receipt?.ok === true && last.receipt?.sessionId === mission[`${role}ThreadId`] && last.receipt?.metadata?.terminationCause === "EXIT";
  }

  async function runRole(mission, role, prompt) {
    const attemptId = randomUUID();
    let profile, record, thread, conflict = false, invoked = false, resumed = false;
    const modelPolicies = Object.fromEntries(rolePolicy.roles.map((name) => [name, modelRouter.route({
      kind: name === "reviewer" ? "routine-review" : mission.repairRounds ? "difficult-repair" : "implementation",
      engine: trustedPolicies?.[name]?.engine || "claude", failedRepairs: name === "worker" ? mission.repairRounds || 0 : 0
    })]));
    try {
      checkSettled(mission);
      const prepared = rolePolicy.compileRolePolicies({ root, mission, policies: trustedPolicies, modelPolicies });
      const current = prepared[role];
      profile = current.profile;
      const engine = profile.engine;
      const peer = role === "worker" ? "reviewer" : "worker";
      record = mission.roleSessions?.[role];
      const priorId = record?.sessionId || mission[`${role}ThreadId`];
      if (priorId && priorId === mission[`${peer}ThreadId`]) throw Object.assign(new Error("role sessions must be independent"), { code: "POLICY_DENIED" });
      if (priorId && !record) {
        if (!legacySettled(mission, role)) throw Object.assign(new Error("legacy session requires reconciliation"), { code: "RECONCILIATION_REQUIRED" });
        resetRole(mission, role, "LEGACY_SESSION");
        record = null;
      } else if (record?.sessionId && (record.version !== 1 || record.missionId !== mission.id || record.role !== role || record.engine !== engine || record.profileDigest !== profile.digest)) {
        resetRole(mission, role, "SESSION_POLICY_CHANGED");
        record = null;
      }
      const workerAdapter = adapter || adapterFactory(current.config);
      if (record?.sessionId) {
        try {
          thread = workerAdapter.resumeThread(record.sessionId, { ...current.options, resumeProfileDigest: record.profileDigest });
          resumed = true;
        } catch (error) {
          if (!["THREAD_NOT_FOUND", "SESSION_POLICY_CHANGED"].includes(error.code)) throw error;
          resetRole(mission, role, error.code);
        }
      }
      if (!thread) thread = workerAdapter.startThread(current.options);
      if (thread.profile?.digest !== profile.digest) throw Object.assign(new Error("adapter did not bind the effective role policy"), { code: "ISOLATION_UNSUPPORTED" });
      if (role === "worker") setMissionState(mission, "building");
      record = { version: 1, missionId: mission.id, role, engine, sessionId: resumed ? record.sessionId : null, profileDigest: profile.digest, attemptId, status: "running", terminalCause: null, externalEffects: "UNKNOWN" };
      session(mission, role, record);
      invoked = true;
      const result = await thread.run(prompt, {
        onThreadId: (id) => {
          if (!id) return;
          if (id === mission[`${peer}ThreadId`]) { conflict = true; thread.cancel?.(); return; }
          record = { ...record, sessionId: id };
          session(mission, role, record);
        }
      });
      const returnedId = result.sessionId || result.threadId;
      if (conflict || !returnedId || returnedId === mission[`${peer}ThreadId`] || returnedId !== record.sessionId) {
        throw Object.assign(new Error("role session identity mismatch"), { code: "POLICY_DENIED", details: { receipt: { metadata: result.metadata } } });
      }
      if (result.ok === false || result.metadata?.profileDigest !== profile.digest || result.metadata?.terminationCause !== "EXIT" || result.metadata?.ownedRunSettled !== true) {
        throw Object.assign(new Error("role receipt is not a verified terminal success"), { code: result.metadata?.terminationCause === "CLEANUP_FAILED" ? "CLEANUP_FAILED" : "RECONCILIATION_REQUIRED", details: { receipt: { metadata: result.metadata } } });
      }
      record = { ...record, status: "settled", terminalCause: "EXIT", externalEffects: result.metadata.externalEffects || "UNKNOWN" };
      session(mission, role, record);
      emit({ type: "agent.receipt", missionId: mission.id, role, attemptId, receipt: compactReceipt(result) });
      tokenGovernor.record(root, { scope: `mission:${mission.id}:${role}`, prompt, receipt: result, modelPolicy: { ...modelPolicies[role], model: profile.model, reusedSession: resumed } });
      return result;
    } catch (error) {
      const metadata = error.details?.receipt?.metadata;
      const terminal = metadata?.terminationCause;
      const code = error.code === "CLEANUP_FAILED" || terminal === "CLEANUP_FAILED" ? "CLEANUP_FAILED" : conflict ? "POLICY_DENIED" : error.code || "POLICY_DENIED";
      const settled = code !== "CLEANUP_FAILED" && code !== "RECONCILIATION_REQUIRED" && (!invoked || (metadata?.profileDigest === profile?.digest && metadata?.ownedRunSettled === true && ["EXIT", "TIMEOUT", "CANCELLED", "OUTPUT_LIMIT", "SPAWN_ERROR"].includes(terminal)));
      if (invoked || code === "CLEANUP_FAILED" || code === "RECONCILIATION_REQUIRED") session(mission, role, {
        version: 1, missionId: mission.id, role, engine: profile?.engine || null, sessionId: mission[`${role}ThreadId`] || null, profileDigest: profile?.digest || null, attemptId,
        ...record, status: settled ? "settled" : "uncertain", terminalCause: code === "CLEANUP_FAILED" ? code : terminal || code, externalEffects: "UNKNOWN" });
      emit({ type: "mission.attempt.finished", missionId: mission.id, role, attemptId, code, receipt: { ok: false, engine: profile?.engine || null, sessionId: record?.sessionId || null,
        metadata: { profileDigest: profile?.digest || null, terminationCause: terminal || code, externalEffects: invoked || !settled ? "UNKNOWN" : "NONE_DECLARED", ownedRunSettled: settled, synthetic: profile?.synthetic ?? null } } });
      throw Object.assign(new Error(`role ${role} failed: ${code}`), { code, role, settled });
    }
  }

  function verify(mission) {
    const results = [];
    for (const command of mission.verifyCommands || []) {
      const allowed = policy.commandAllowed(command, { trustDomain: mission.trustDomain });
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
    const prompt = reviewPrompt(mission);
    const res = await runRole(mission, "reviewer", prompt);
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

  async function accept(mission) {
    const commands = mission.acceptanceCommands && mission.acceptanceCommands.length
      ? mission.acceptanceCommands
      : mission.verifyCommands;
    const results = commands.map((command) => {
      const allowed = policy.commandAllowed(command, { trustDomain: mission.trustDomain });
      if (!allowed.ok) return { command, passed: false, refused: true, reason: allowed.detail || allowed.reason };
      const r = spawnSync("/bin/bash", ["-lc", command], { cwd: mission.worktree, encoding: "utf8", timeout: 120000 });
      return { command, passed: r.status === 0, exitCode: r.status, output: `${r.stdout || ""}${r.stderr || ""}`.slice(-2000) };
    });
    setField(mission, "acceptance", results);
    emit({ type: "acceptance.finished", missionId: mission.id, results });
    if (results.some((r) => !r.passed)) return queueRepair(mission, results.map((r) => `acceptance failed: ${r.command}`));
    if (mission.syntheticJarvisAcceptance) {
      const synthetic = await jarvisAcceptance.runSyntheticAcceptance(
        { identity: mission.candidate && mission.candidate.verified && mission.candidate.verified.identity || (mission.candidateSpec && mission.candidateSpec.identity) || mission.id },
        mission.syntheticJarvisAcceptance
      );
      emit({ type: "jarvis.acceptance.finished", missionId: mission.id, result: synthetic });
      if (!synthetic.ok) {
        setField(mission, "acceptance", results.concat(synthetic.results.map((r) => ({
          command: `synthetic:${r.check}`,
          passed: r.passed,
          reason: r.detail
        }))));
        return queueRepair(mission, synthetic.results.filter((r) => !r.passed).map((r) => `synthetic JARVIS acceptance failed: ${r.check}`));
      }
    }
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

  async function step({ missionId } = {}) {
    let state = journal.load(root);
    if (!state.ok) return { progressed: false, summary: `blocked: ${state.reason}` };
    const requested = state.missions.get(missionId);
    if (requested?.preparationRequestId && state.preparations.get(requested.preparationRequestId)?.status !== "prepared") {
      return { progressed: false, code: "PREPARATION_BLOCKED", summary: "mission preparation is unresolved" };
    }
    const queuedGoal = !missionId && [...state.goals.values()].find((g) => g.state === "queued");
    if (queuedGoal) {
      architect(queuedGoal);
      return { progressed: true, summary: "architected goal" };
    }
    state = journal.load(root);
    const mission = [...state.missions.values()].find((m) => (!missionId || m.id === missionId)
      && (!m.preparationRequestId || state.preparations.get(m.preparationRequestId)?.status === "prepared") && isRunnable(m, state.missions));
    if (!mission) return { progressed: false, summary: "idle" };
    try {
      checkSettled(mission);
      if (["queued", "building", "repair"].includes(mission.state)) await build(mission);
      else if (mission.state === "verifying") verify(mission);
      else if (mission.state === "reviewing") await review(mission);
      else if (mission.state === "integrating") integrate(mission);
      else if (mission.state === "candidate") createCandidate(mission);
      else if (mission.state === "accepting") await accept(mission);
      journal.writeSnapshot(root);
      return { progressed: true, summary: `advanced ${mission.id}` };
    } catch (e) {
      if (e.code === "INTERRUPTED" && e.settled) {
        emit({ type: "worker.interrupted", missionId: mission.id, message: e.message });
        journal.writeSnapshot(root);
        return { progressed: true, interrupted: true, summary: `interrupted ${mission.id}; restart will resume` };
      }
      if (e.code === "PROVIDER_QUOTA" && e.settled) {
        emit({ type: "provider.quota", missionId: mission.id, engine: trustedPolicies?.[e.role]?.engine || "unknown", message: e.message });
        journal.writeSnapshot(root);
        return { progressed: false, backoff: true, summary: `provider quota for ${mission.id}` };
      }
      const role = e.role || "worker";
      if (["THREAD_NOT_FOUND", "TIMEOUT", "MALFORMED_WORKER_RESPONSE"].includes(e.code) && mission.roleSessions?.[role]?.status === "settled") {
        resetRole(mission, role, e.code);
        setMissionState(mission, role === "reviewer" ? "reviewing" : "repair");
        return { progressed: true, summary: `replaced ${role} for ${mission.id}: ${e.code}` };
      }
      emit({ type: "mission.blocked", missionId: mission.id, role: e.role || null, code: e.code || "AGENT_FAILED" });
      if (!e.role) emit({ type: "mission.attempt.finished", missionId: mission.id, role: mission.state === "reviewing" ? "reviewer" : "worker", code: e.code || "AGENT_FAILED",
        receipt: { ok: false, metadata: { profileDigest: null, terminationCause: e.code || "AGENT_FAILED", externalEffects: ["CLEANUP_FAILED", "RECONCILIATION_REQUIRED"].includes(e.code) ? "UNKNOWN" : "NONE_DECLARED" } } });
      setMissionState(mission, "blocked", { blocker: e.code ? `${e.code}: ${e.message}` : e.message });
      journal.writeSnapshot(root);
      return { progressed: true, code: e.code || "AGENT_FAILED", summary: `blocked ${mission.id}: ${e.message}` };
    }
  }

  async function run({ maxSteps = 100, missionId } = {}) {
    const paused = path.join(journal.paths(root).root, "PAUSED");
    if (require("node:fs").existsSync(paused)) return { ok: true, summary: "paused" };
    return lease.withLease(root, async () => {
      let summary = "idle";
      for (let i = 0; i < maxSteps; i++) {
        const r = await step({ missionId });
        summary = r.summary;
        if (r.code) return { ok: false, code: r.code, summary };
        if (r.interrupted || r.backoff || !r.progressed) return { ok: true, summary, backoff: !!r.backoff };
      }
      return { ok: true, summary };
    });
  }

  return { enqueueGoal, run, step };
}

function compactReceipt(result) {
  return {
    ok: result.ok !== false,
    engine: result.engine || null,
    sessionId: result.sessionId || result.threadId || null,
    metadata: result.metadata || {},
    outputBytes: Buffer.byteLength(String(result.finalResponse || ""))
  };
}

function isRunnable(mission, missions) {
  const active = ["queued", "building", "repair", "verifying", "reviewing", "integrating", "candidate", "accepting"];
  if (!active.includes(mission.state)) return false;
  for (const depId of mission.dependsOn || []) {
    const dep = missions.get(depId);
    if (!dep || dep.state !== "ready_for_human_check") return false;
  }
  return true;
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

module.exports = { createController, planGoal, parseReview, workerPrompt, reviewPrompt, compactReceipt };
