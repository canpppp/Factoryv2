"use strict";

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createLinuxOwnership } = require("./linux-ownership");

const DEFAULT_LIMITS = Object.freeze({ lineBytes: 1024 * 1024, stdoutBytes: 8 * 1024 * 1024, events: 4096, invalidLines: 32, stderrBytes: 65536, killGraceMs: 500, cleanupMs: 3000 });
function validateLimits(value = {}) {
  const limits = { ...DEFAULT_LIMITS, ...value };
  for (const [key, number] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(number) || number <= 0 || number > DEFAULT_LIMITS[key]) throw Object.assign(new Error(`invalid worker limit: ${key}`), { code: "POLICY_DENIED" });
  }
  return Object.freeze(limits);
}

function runJsonlProcess({ command, args = [], cwd, input, timeoutMs = 300000, env = {}, limits: configured, onEvent, onSpawn, ownership }) {
  const limits = validateLimits(configured);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1800000) throw Object.assign(new Error("invalid worker timeout"), { code: "POLICY_DENIED" });
  if (ownership && (ownership !== "linux-pid-namespace-v1" || process.platform !== "linux")) throw Object.assign(new Error("unsupported ownership boundary"), { code: "ISOLATION_UNSUPPORTED" });
  const runId = randomUUID();
  let child, cause = null, settled = false, closed = false, exitCode = null, exitSignal = null;
  let timer, killTimer, deadlineTimer, groupTimer, ownershipTimer, namespaceOwner, released = false;
  let pending = Buffer.alloc(0), stderr = Buffer.alloc(0);
  const events = [], invalidLines = [];
  const counts = { stdoutBytes: 0, stderrBytes: 0, events: 0, invalidLines: 0, pendingBytes: 0 };
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  function groupAlive() {
    if (!child?.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  }
  function signalOwned(signal) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") cause = "CLEANUP_FAILED"; }
  }
  function finish() {
    if (settled) return;
    settled = true;
    const ownershipReceipt = namespaceOwner?.receipt();
    if (ownership && ownershipReceipt?.state !== "TERMINATED") cause = "CLEANUP_FAILED";
    for (const t of [timer, killTimer, deadlineTimer]) clearTimeout(t);
    clearInterval(groupTimer);
    clearInterval(ownershipTimer);
    child?.stdio?.[3]?.destroy(); child?.stdio?.[4]?.destroy();
    namespaceOwner?.close();
    child?.stdout?.removeAllListeners("data"); child?.stderr?.removeAllListeners("data");
    child?.stdout?.destroy(); child?.stderr?.destroy(); child?.stdin?.destroy();
    child?.removeAllListeners("exit"); child?.removeAllListeners("close");
    child?.removeAllListeners("error"); child?.on("error", () => {});
    child?.unref();
    pending = Buffer.alloc(0);
    resolve({ runId, pid: child?.pid || null, code: exitCode, signal: exitSignal, cause: cause || "EXIT", events, invalidLines, stderr: stderr.toString("utf8"), counts: { ...counts }, timedOut: cause === "TIMEOUT", cancelled: cause === "CANCELLED", ...(ownershipReceipt ? { ownership: ownershipReceipt } : {}) });
  }
  function namespaceDone() { return !ownership || namespaceOwner?.observe() === "TERMINATED"; }
  function checkCleanup() { if (closed && !groupAlive() && namespaceDone()) finish(); }
  function cleanupTimers() {
    if (deadlineTimer) return;
    killTimer = setTimeout(() => { signalOwned("SIGKILL"); checkCleanup(); }, limits.killGraceMs);
    groupTimer = setInterval(checkCleanup, 20);
    deadlineTimer = setTimeout(() => { signalOwned("SIGKILL"); if (!closed || groupAlive() || !namespaceDone()) cause = "CLEANUP_FAILED"; finish(); }, limits.killGraceMs + limits.cleanupMs);
  }
  function terminate(reason) {
    if (settled || cause) return false;
    cause = reason;
    clearTimeout(timer);
    signalOwned("SIGTERM");
    cleanupTimers();
    return true;
  }
  function line(buffer) {
    if (cause || settled || !buffer.toString("utf8").trim()) return;
    let event;
    try { event = JSON.parse(buffer.toString("utf8")); }
    catch {
      if (invalidLines.length >= limits.invalidLines) return terminate("OUTPUT_LIMIT");
      invalidLines.push(buffer.toString("utf8")); counts.invalidLines++;
      return;
    }
    if (events.length >= limits.events) return terminate("OUTPUT_LIMIT");
    events.push(event); counts.events++;
    try { onEvent?.(event); } catch { terminate("EVENT_HANDLER_FAILED"); }
  }
  try {
    if (process.platform === "win32") throw new Error("owned process groups unavailable");
    child = spawn(command, args, { cwd, env: { ...env }, detached: true, stdio: ownership ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
    if (ownership) {
      namespaceOwner = createLinuxOwnership(child.pid);
      child.stdio[3].on("data", namespaceOwner.data);
      child.stdio[3].on("end", namespaceOwner.end);
      child.stdio[3].on("error", () => terminate("CLEANUP_FAILED"));
      child.stdio[4].on("error", () => terminate("CLEANUP_FAILED"));
      ownershipTimer = setInterval(() => {
        if (namespaceOwner.invalid()) return terminate("CLEANUP_FAILED");
        if (namespaceOwner.observe() === "ACTIVE" && !released && !cause) {
          released = true; child.stdio[4].end("1");
        }
        checkCleanup();
      }, 10);
    }
    child.on("error", () => { closed = true; terminate("SPAWN_ERROR"); checkCleanup(); });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      if (cause || settled) return;
      if (counts.stdoutBytes + chunk.length > limits.stdoutBytes) return terminate("OUTPUT_LIMIT");
      counts.stdoutBytes += chunk.length;
      let offset = 0;
      while (offset < chunk.length && !cause && !settled) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (pending.length + end - offset > limits.lineBytes) return terminate("OUTPUT_LIMIT");
        pending = Buffer.concat([pending, chunk.subarray(offset, end)]);
        counts.pendingBytes = Math.max(counts.pendingBytes, pending.length);
        if (newline < 0) break;
        line(pending); pending = Buffer.alloc(0); offset = end + 1;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (cause || settled) return;
      if (counts.stderrBytes + chunk.length > limits.stderrBytes) return terminate("OUTPUT_LIMIT");
      counts.stderrBytes += chunk.length; stderr = Buffer.concat([stderr, chunk]);
    });
    child.on("exit", (code, signal) => {
      exitCode = code; exitSignal = signal;
      // A leader can exit while descendants still hold its pipes open.
      if (groupAlive()) terminate("DESCENDANTS_REMAINED");
    });
    child.on("close", (code, signal) => {
      closed = true; exitCode = code; exitSignal = signal;
      if (!cause) {
        if (pending.length) line(pending);
        if (!cause) {
          clearTimeout(timer);
          if (!ownership) finish();
          else { checkCleanup(); if (!settled) cleanupTimers(); }
        }
      }
      else checkCleanup();
    });
    timer = setTimeout(() => terminate("TIMEOUT"), timeoutMs);
    onSpawn?.(child);
    child.stdin.end(String(input || ""));
  } catch {
    if (child?.pid) terminate("SPAWN_ERROR");
    else { cause = "SPAWN_ERROR"; closed = true; finish(); }
  }
  return { runId, promise, cancel: () => terminate("CANCELLED") };
}

function classifiedError(message, details = {}) {
  const text = `${message || ""}\n${details.stderr || ""}`;
  const error = new Error(message || "agent process failed");
  if (details.cause && details.cause !== "EXIT") error.code = details.cause;
  else if (details.timedOut) error.code = "TIMEOUT";
  else if (details.cancelled) error.code = "CANCELLED";
  else if (/rate.?limit|quota|capacity|overloaded|too many requests|529|429/i.test(text)) error.code = "PROVIDER_QUOTA";
  else if (/session|thread/.test(text.toLowerCase()) && /not found|unknown|invalid/.test(text.toLowerCase())) error.code = "THREAD_NOT_FOUND";
  else if (/auth|login|credential|unauthorized|forbidden/i.test(text)) error.code = "AUTH_REQUIRED";
  else error.code = "AGENT_FAILED";
  error.details = details;
  return error;
}

module.exports = { runJsonlProcess, classifiedError, validateLimits, DEFAULT_LIMITS };
