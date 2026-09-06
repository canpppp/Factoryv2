"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { compileWorkerPolicy } = require("./adapters/worker-policy");

const roles = ["worker", "reviewer"];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const within = (file, root) => file === root || file.startsWith(`${root}${path.sep}`);
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const reserved = ["workerPolicy", "rolePolicies", "rolePoliciesPath", "roleSessions", "workerThreadId", "reviewerThreadId", "adapter", "engine", "command", "executable", "env", "auth", "stateRoot", "runtimeReadRoots", "resumeProfileDigest", "controllerBinding", "worktree", "cwd"];

function assertMissionInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("POLICY_DENIED", "mission overrides must be an object");
  for (const key of reserved) if (Object.hasOwn(input, key)) fail("POLICY_DENIED", `mission cannot supply ${key}`);
  if (input.id && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.id)) fail("POLICY_DENIED", "invalid mission identity");
  if (input.missions) {
    if (!Array.isArray(input.missions)) fail("POLICY_DENIED", "missions must be a list");
    input.missions.forEach(assertMissionInput);
  }
}

function loadRolePolicies({ rolePolicies, rolePoliciesPath } = {}) {
  if (rolePolicies && rolePoliciesPath) fail("POLICY_DENIED", "choose one trusted role policy source");
  try {
    const file = rolePoliciesPath ? fs.realpathSync(rolePoliciesPath) : null;
    const value = file ? JSON.parse(fs.readFileSync(file, "utf8")) : rolePolicies;
    if (file) {
      const stat = fs.statSync(file);
      if (!stat.isFile() || (stat.mode & 0o022)) fail("POLICY_DENIED", "role policy file is not trusted");
      for (const role of roles) for (const write of value?.[role]?.workerPolicy?.writeRoots || []) {
        if (within(file, fs.realpathSync(write))) fail("POLICY_DENIED", "role policy file is writable by a worker");
      }
    }
    return value ? freeze(JSON.parse(JSON.stringify(value))) : null;
  } catch { fail("POLICY_DENIED", "cannot read trusted role policy configuration"); }
}

function requireRolePolicies(policies) {
  for (const role of roles) {
    const config = policies?.[role];
    if (!config?.workerPolicy || !["claude", "codex"].includes(config.engine)) fail("ISOLATION_UNSUPPORTED", `explicit ${role} adapter policy required`);
    if (!Array.isArray(config.workerPolicy.readRoots) || !Array.isArray(config.workerPolicy.writeRoots)) fail("POLICY_DENIED", `explicit ${role} roots required`);
    if (role === "reviewer" && config.workerPolicy.writeRoots.length) fail("POLICY_DENIED", "reviewer policy must not grant business writes");
  }
}

function compileRolePolicies({ root, mission, policies, modelPolicies }) {
  requireRolePolicies(policies);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(mission.id)) fail("POLICY_DENIED", "invalid mission identity");
  const controllerRoot = fs.realpathSync(root);
  const expected = path.join(controllerRoot, "worktrees", mission.id);
  const worktree = fs.realpathSync(mission.worktree);
  if (worktree !== expected) fail("POLICY_DENIED", "mission worktree is not its controller-owned path");
  const requests = mission.roleRequests || {};
  if (typeof requests !== "object" || Array.isArray(requests) || Object.keys(requests).some((key) => !roles.includes(key))) fail("POLICY_DENIED", "invalid role requests");
  const result = {};
  for (const role of roles) {
    const config = policies[role], spec = config.workerPolicy;
    const request = requests[role] || {};
    const allowedKeys = ["allowedTools", "disallowedTools", "readRoots", "writeRoots", "limits", "timeoutMs", "maxTurns"];
    if (typeof request !== "object" || Array.isArray(request) || Object.keys(request).some((key) => !allowedKeys.includes(key))) fail("POLICY_DENIED", "jobs may only narrow role options");
    const stateBase = fs.realpathSync(spec.stateRoot);
    if (within(stateBase, worktree) || within(worktree, stateBase) || (fs.statSync(stateBase).mode & 0o077)) fail("POLICY_DENIED", "role private state must be private and outside the mission worktree");
    for (const runtime of spec.runtimeReadRoots || []) {
      const runtimeRoot = fs.realpathSync(runtime);
      if ([worktree, ...roles.map((name) => fs.realpathSync(policies[name].workerPolicy.stateRoot))].some((privateRoot) => within(runtimeRoot, privateRoot) || within(privateRoot, runtimeRoot))) fail("POLICY_DENIED", "runtime roots cannot expose mission data or role private state");
    }
    const binding = { controllerRoot, missionId: mission.id, role };
    const identity = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
    const stateRoot = path.join(stateBase, identity);
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(stateRoot) !== stateRoot) fail("POLICY_DENIED", "role private state path changed");
    const intersect = (grants) => [...new Set(grants.map((file) => {
      const grant = fs.realpathSync(file);
      return within(worktree, grant) ? worktree : within(grant, worktree) ? grant : null;
    }).filter(Boolean))];
    const tools = config.allowedTools ?? spec.tools ?? [];
    if (!Array.isArray(tools) || (request.allowedTools && (!Array.isArray(request.allowedTools) || request.allowedTools.some((tool) => !tools.includes(tool))))) fail("POLICY_DENIED", "job tools exceed trusted role availability");
    if (role === "reviewer" && request.writeRoots?.length) fail("POLICY_DENIED", "reviewer cannot request writes");
    const maxTurns = config.maxTurns ?? (role === "reviewer" ? 6 : 12);
    if (request.maxTurns != null && (!Number.isSafeInteger(request.maxTurns) || request.maxTurns < 1 || request.maxTurns > maxTurns)) fail("POLICY_DENIED", "job turn budget exceeds role policy");
    const timeoutMs = Math.min(config.timeoutMs ?? 1800000, spec.timeoutMs ?? 300000);
    if (request.timeoutMs != null && request.timeoutMs > timeoutMs) fail("POLICY_DENIED", "job timeout exceeds role policy");
    const boundedConfig = { ...config, maxTurns, workerPolicy: { ...spec, stateRoot, readRoots: intersect(spec.readRoots), writeRoots: role === "reviewer" ? [] : intersect(spec.writeRoots) } };
    const options = { ...request, role, cwd: worktree, readOnly: role === "reviewer", controllerBinding: binding,
      allowedTools: request.allowedTools ?? tools, maxTurns: request.maxTurns ?? maxTurns,
      model: config.model || modelPolicies[role].model, timeoutMs: request.timeoutMs ?? timeoutMs };
    const profile = compileWorkerPolicy(config.engine, boundedConfig, options);
    result[role] = { config: boundedConfig, options, profile };
  }
  return result;
}

module.exports = { roles, assertMissionInput, loadRolePolicies, requireRolePolicies, compileRolePolicies };
