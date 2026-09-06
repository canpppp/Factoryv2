"use strict";

const { randomUUID } = require("node:crypto");
const { runJsonlProcess, classifiedError } = require("./process");
const { compileWorkerPolicy, prepareWorker } = require("./worker-policy");

function createOwnedAdapter(engine, config, buildArgs, makeReceipt) {
  const active = new Map(), sessions = new Map();
  function thread(sessionId, options) {
    // Snapshot trusted config/options now; later caller mutations cannot widen this run.
    const profile = compileWorkerPolicy(engine, config, { ...options, timeoutMs: options.timeoutMs ?? config.timeoutMs });
    if (sessionId && (options.resumeProfileDigest || sessions.get(sessionId)) !== profile.digest) {
      throw Object.assign(new Error("session permission profile changed or is unknown"), { code: "SESSION_POLICY_CHANGED" });
    }
    let handle = null, cancelled = false, running = false;
    return {
      id: sessionId,
      profile,
      cancel() { cancelled = true; return handle ? handle.cancel() : true; },
      async run(prompt, hooks = {}) {
        if (running) throw Object.assign(new Error("worker thread is already running"), { code: "WORKER_BUSY" });
        running = true;
        let id = sessionId || (engine === "claude" ? randomUUID() : null);
        let runKey;
        try {
          if (cancelled) throw Object.assign(new Error("worker cancelled before spawn"), { code: "CANCELLED" });
          const args = buildArgs({ cwd: profile.cwd, readOnly: !profile.writeRoots.length, allowedTools: profile.tools, disallowedTools: profile.disallowedTools, model: profile.model, maxTurns: profile.maxTurns, sessionId, newSessionId: engine === "claude" && !sessionId ? id : null, threadId: sessionId });
          const prepared = prepareWorker(profile, args);
          hooks.onPolicy?.({ profileDigest: profile.digest, executableSha256: profile.executableSha256, engine, synthetic: profile.synthetic });
          if (id) { sessions.set(id, profile.digest); hooks.onThreadId?.(id); }
          handle = runJsonlProcess({ ...prepared, cwd: profile.cwd, input: prompt, timeoutMs: profile.timeoutMs, limits: profile.limits,
            onEvent(event) {
              const found = event.session_id || event.thread_id || event.threadId;
              if (found && found !== id) { id = found; sessions.set(id, profile.digest); active.set(id, handle); hooks.onThreadId?.(id); }
              // Raw provider events never leave the redaction boundary.
              hooks.onEvent?.(JSON.parse(prepared.redact(JSON.stringify(event))));
            }
          });
          runKey = handle.runId; active.set(runKey, handle);
          if (id) active.set(id, handle);
          hooks.onRunId?.(runKey);
          if (cancelled) handle.cancel();
          const raw = await handle.promise;
          const result = JSON.parse(prepared.redact(JSON.stringify(raw)));
          const receipt = makeReceipt(result, id, { model: profile.model });
          receipt.origin = profile.synthetic ? "synthetic" : "adapter";
          receipt.metadata = { ...receipt.metadata, profileDigest: profile.digest, executableSha256: profile.executableSha256, runId: runKey, pid: result.pid, terminationCause: result.cause, ownedRunSettled: result.cause !== "CLEANUP_FAILED", ownership: result.ownership || null, counts: result.counts, synthetic: profile.synthetic, externalEffects: result.cause === "EXIT" ? "NONE_DECLARED" : "UNKNOWN" };
          if (!receipt.ok) {
            const error = classifiedError(receipt.error, result);
            error.message = `worker failed: ${error.code}`;
            error.details = { receipt: { engine, sessionId: id, metadata: receipt.metadata } };
            throw error;
          }
          return receipt;
        } finally {
          if (handle) for (const [key, value] of active) if (value === handle) active.delete(key);
          running = false;
        }
      }
    };
  }
  return { engine, startThread: (options = {}) => thread(null, options), resumeThread: (id, options = {}) => thread(id, options), cancelThread: (id) => !!active.get(id)?.cancel() };
}

module.exports = { createOwnedAdapter };
