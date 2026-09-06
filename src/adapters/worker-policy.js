"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { validateLimits } = require("./process");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message, code = "POLICY_DENIED") => { throw Object.assign(new Error(message), { code }); };
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const within = (file, root) => file === root || file.startsWith(`${root}${path.sep}`);
function canonical(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) fail("worker paths must be absolute");
  return fs.realpathSync(file);
}
function roots(requested, granted) {
  if (!Array.isArray(requested)) fail("worker roots must be arrays");
  const result = [...new Set(requested.map(canonical))].sort();
  if (result.some((file) => !granted.some((root) => within(file, root)))) fail("job roots exceed channel authority");
  return result;
}

function toolNames(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) fail(`${name} must be a list of tool names`);
  if (value.some((tool) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(tool))) fail(`${name} supports exact tool names only`, "ISOLATION_UNSUPPORTED");
  return value;
}

function compileWorkerPolicy(engine, config, options) {
  const configured = config.workerPolicy || options.workerPolicy;
  if (!configured) fail("explicit worker isolation profile is required", "ISOLATION_UNSUPPORTED");
  const spec = JSON.parse(JSON.stringify(configured));
  const executable = canonical(config.command || spec.executable);
  const executableSha256 = hash(fs.readFileSync(executable));
  if (!spec.executableSha256 || spec.executableSha256 !== executableSha256) fail("worker executable digest mismatch");
  const synthetic = spec.auth?.mode === "none" && spec.protocolFixtureSha256 === executableSha256;
  const entrypoint = synthetic && spec.entrypoint ? canonical(spec.entrypoint) : null;
  const entrypointSha256 = entrypoint ? hash(fs.readFileSync(entrypoint)) : null;
  if (entrypoint && entrypointSha256 !== spec.entrypointSha256) fail("worker entrypoint digest mismatch");
  if (!synthetic && engine === "codex") fail("Codex CLI exact tool availability and isolated subscription resume are not established", "ISOLATION_UNSUPPORTED");
  if (!synthetic && (engine !== "claude" || spec.auth?.mode !== "subscription-token")) fail("unsupported isolated subscription auth", "ISOLATION_UNSUPPORTED");
  if (!synthetic) fail("live subscription egress and descendant isolation are not certified for this adapter", "ISOLATION_UNSUPPORTED");
  if (process.platform !== "darwin" && process.platform !== "linux") fail("worker OS confinement unavailable", "ISOLATION_UNSUPPORTED");
  const sandbox = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap";
  if (!fs.existsSync(sandbox)) fail("worker OS confinement executable missing", "ISOLATION_UNSUPPORTED");
  const cwd = canonical(options.cwd);
  const grantedRead = (spec.readRoots || [cwd]).map(canonical);
  const grantedWrite = (spec.writeRoots || []).map(canonical);
  const readRoots = roots(options.readRoots || grantedRead, grantedRead);
  const writeRoots = options.readOnly ? [] : roots(options.writeRoots || grantedWrite, grantedWrite);
  if (process.platform === "linux" && writeRoots.some((write) => !readRoots.some((read) => within(write, read)))) fail("Linux write binds require covering read authority", "ISOLATION_UNSUPPORTED");
  const requestedTools = toolNames(options.allowedTools ?? config.allowedTools, "allowedTools");
  const disallowedTools = [...new Set([
    ...toolNames(spec.disallowedTools, "policy disallowedTools"),
    ...toolNames(config.disallowedTools, "config disallowedTools"),
    ...toolNames(options.disallowedTools, "disallowedTools")
  ])].sort();
  if (engine !== "claude" && disallowedTools.length) fail("adapter cannot enforce explicit tool denials", "ISOLATION_UNSUPPORTED");
  const permitted = toolNames(spec.tools, "policy tools");
  if (requestedTools.some((tool) => !permitted.includes(tool))) fail("job tools exceed channel worker policy");
  const tools = [...new Set(requestedTools.filter((tool) => !disallowedTools.includes(tool)))].sort();
  const supported = ["Read", "Glob", "Grep", "Edit", "Write"];
  if (!synthetic && tools.some((tool) => !supported.includes(tool))) fail("requested tool cannot be confined by this adapter", "ISOLATION_UNSUPPORTED");
  if (!writeRoots.length && tools.some((tool) => ["Edit", "Write", "NotebookEdit"].includes(tool))) fail("write tools require write roots");
  const channelLimits = validateLimits(spec.limits);
  const limits = validateLimits({ ...channelLimits, ...options.limits });
  if (Object.keys(limits).some((key) => limits[key] > channelLimits[key])) fail("job output budgets exceed channel policy");
  const timeoutMs = options.timeoutMs ?? spec.timeoutMs ?? 300000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > (spec.timeoutMs || 300000) || timeoutMs > 1800000) fail("job timeout exceeds channel policy");
  const stateRoot = canonical(spec.stateRoot);
  if (readRoots.concat(writeRoots).some((root) => within(stateRoot, root) || within(root, stateRoot))) fail("worker state must be separate from business roots");
  if (fs.statSync(stateRoot).mode & 0o077) fail("worker state root must be private (0700)");
  const runtimeReadRoots = (spec.runtimeReadRoots || []).map(canonical);
  if (!synthetic && runtimeReadRoots.length) fail("custom runtime exceptions require adapter validation", "ISOLATION_UNSUPPORTED");
  const profile = {
    version: 2, channelId: options.channelId || null, engine, executable, executableSha256, entrypoint, entrypointSha256, synthetic, cwd, tools, disallowedTools, readRoots, writeRoots,
    stateRoot, runtimeReadRoots, sandbox, timeoutMs, limits,
    model: options.model || config.model || null, maxTurns: options.maxTurns || config.maxTurns || 12,
    auth: { mode: spec.auth.mode, source: synthetic ? null : spec.auth.tokenEnv },
    configuration: "private-home-safe-mode-no-mcp-no-settings", environmentKeys: ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", ...(synthetic ? [] : ["CLAUDE_CODE_OAUTH_TOKEN"])]
  };
  if (!synthetic && (!/^FACTORYV2_[A-Z0-9_]+$/.test(profile.auth.source || ""))) fail("subscription token requires a named Factory source");
  if (!Number.isSafeInteger(profile.maxTurns) || profile.maxTurns <= 0 || profile.maxTurns > (config.maxTurns || 12)) fail("worker turn budget exceeds policy");
  // Digest excludes credential values; changing token values never grants new authority.
  return freeze({ ...profile, digest: hash(JSON.stringify(profile)) });
}

function prepareWorker(profile, args) {
  if (hash(fs.readFileSync(profile.executable)) !== profile.executableSha256) fail("worker executable changed before spawn");
  if (profile.entrypoint && hash(fs.readFileSync(profile.entrypoint)) !== profile.entrypointSha256) fail("worker entrypoint changed before spawn");
  for (const root of [...profile.readRoots, ...profile.writeRoots, profile.stateRoot, ...profile.runtimeReadRoots]) {
    if (canonical(root) !== root) fail("worker root changed before spawn");
  }
  const home = path.join(profile.stateRoot, profile.digest);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (canonical(home) !== home || (fs.statSync(home).mode & 0o077)) fail("worker home must remain private and canonical");
  const temp = path.join(home, "tmp"); fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  const env = { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: temp, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex") };
  let secret = null;
  if (!profile.synthetic) {
    secret = process.env[profile.auth.source];
    if (!secret || !secret.startsWith("sk-ant-oat")) fail("configured subscription token unavailable", "AUTH_REQUIRED");
    env.CLAUDE_CODE_OAUTH_TOKEN = secret;
  }
  const redact = (text) => {
    let result = String(text || "");
    if (secret) result = result.split(secret).join("[REDACTED]");
    return result.replace(/(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
  };
  const systemRead = process.platform === "darwin"
    ? ["/System/Library", "/System/Volumes/Preboot/Cryptexes/OS", "/usr/lib", "/usr/share/locale", "/private/var/db/dyld"]
    : ["/usr/lib", "/usr/lib64", "/lib", "/lib64", "/usr/share/locale"];
  const reads = [...new Set([...systemRead.filter(fs.existsSync), profile.executable, ...profile.runtimeReadRoots, ...profile.readRoots, home, ...(profile.entrypoint ? [profile.entrypoint] : [])])];
  if (profile.entrypoint) args = [profile.entrypoint, ...args];
  if (process.platform === "darwin") {
    const quote = (value) => JSON.stringify(value);
    const exceptions = (paths) => `(require-all ${paths.map((root) => `(require-not (subpath ${quote(root)}))`).join(" ")})`;
    const devices = ["/dev/null", "/dev/random", "/dev/urandom"];
    const directories = new Set(["/", profile.cwd]);
    for (const file of reads) {
      let dir = path.dirname(file);
      while (dir !== "/") { directories.add(dir); dir = path.dirname(dir); }
    }
    const readFilter = `(require-all ${[...reads, ...devices].map((root) => `(require-not (subpath ${quote(root)}))`).join(" ")} ${[...directories].map((dir) => `(require-not (literal ${quote(dir)}))`).join(" ")})`;
    const rules = ["(version 1)", "(allow default)", "(deny network*)",
      `(deny file-read-data ${readFilter})`,
      `(deny file-write* ${exceptions([home, ...profile.writeRoots, ...devices])})`,
      `(deny process-exec (require-not (literal ${quote(profile.executable)})))`];
    // Network access is not delegated by this packet. Live provider egress needs M0.3 validation.
    return { command: profile.sandbox, args: ["-p", rules.join("\n"), profile.executable, ...args], env, redact };
  }
  const wrapped = ["--die-with-parent", "--unshare-all", "--new-session", "--proc", "/proc", "--dev", "/dev", "--dir", profile.cwd];
  for (const root of reads) wrapped.push("--ro-bind", root, root);
  for (const root of [home, ...profile.writeRoots]) wrapped.push("--bind", root, root);
  wrapped.push("--chdir", profile.cwd, "--", profile.executable, ...args);
  return { command: profile.sandbox, args: wrapped, env, redact };
}

module.exports = { compileWorkerPolicy, prepareWorker };
