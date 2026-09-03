"use strict";

const { randomUUID } = require("node:crypto");
const { runJsonlProcess, classifiedError } = require("./process");

function createClaudeAdapter(config = {}) {
  const command = config.command || process.env.FACTORYV2_CLAUDE_BIN || "claude";
  const active = new Map();

  function thread(sessionId, options) {
    return {
      id: sessionId,
      async run(prompt, hooks = {}) {
        const id = sessionId || randomUUID();
        hooks.onThreadId?.(id);
        const args = buildArgs({ ...config, ...options, sessionId: sessionId ? id : null, newSessionId: sessionId ? null : id });
        let handle;
        handle = runJsonlProcess({
          command,
          args,
          cwd: options.cwd,
          input: prompt,
          timeoutMs: options.timeoutMs || config.timeoutMs || 300000,
          onSpawn: () => active.set(id, handle),
          onEvent: (event) => {
            if (event.session_id && event.session_id !== id) hooks.onThreadId?.(event.session_id);
            hooks.onEvent?.(event);
          }
        });
        active.set(id, handle);
        const result = await handle.promise;
        active.delete(id);
        const receipt = claudeReceipt(result, id, options);
        if (!receipt.ok) throw classifiedError(receipt.error, { ...result, receipt });
        return receipt;
      },
      cancel() { return cancelThread(sessionId); }
    };
  }

  function cancelThread(sessionId) {
    return !!(sessionId && active.get(sessionId)?.cancel());
  }

  return {
    engine: "claude",
    startThread(options = {}) { return thread(null, normalizeOptions(options, config)); },
    resumeThread(sessionId, options = {}) {
      if (!sessionId) throw classifiedError("session id is required", { stderr: "session not found" });
      return thread(sessionId, normalizeOptions(options, config));
    },
    cancelThread
  };
}

function normalizeOptions(options, config) {
  return {
    ...options,
    model: options.model || config.model,
    maxTurns: options.maxTurns || config.maxTurns || 12,
    allowedTools: options.allowedTools || config.allowedTools,
    disallowedTools: options.disallowedTools || config.disallowedTools
  };
}

function buildArgs(options) {
  const args = ["-p", "--input-format", "text", "--output-format", "stream-json", "--verbose"];
  if (options.sessionId) args.push("--resume", options.sessionId);
  if (options.newSessionId) args.push("--session-id", options.newSessionId);
  args.push("--max-turns", String(options.maxTurns || 12));
  if (options.model) args.push("--model", options.model);
  args.push("--permission-mode", options.readOnly ? "dontAsk" : (options.permissionMode || "auto"));
  if (options.allowedTools?.length) args.push("--allowedTools", options.allowedTools.join(","));
  const denied = [...new Set([...(options.disallowedTools || []), ...(options.readOnly ? ["Edit", "Write", "NotebookEdit"] : [])])];
  if (denied.length) args.push("--disallowedTools", denied.join(","));
  return args;
}

function claudeReceipt(processResult, fallbackSessionId, options = {}) {
  const result = [...processResult.events].reverse().find((event) => event.type === "result");
  const sessionEvent = processResult.events.find((event) => event.session_id);
  const modelEvent = processResult.events.find((event) => event.model || event.model_name);
  const sessionId = result?.session_id || sessionEvent?.session_id || fallbackSessionId;
  const usage = result?.usage || {};
  const ok = processResult.code === 0 && !processResult.timedOut && !processResult.cancelled && result && !result.is_error;
  return {
    ok: !!ok,
    engine: "claude",
    sessionId,
    threadId: sessionId,
    finalResponse: String(result?.result || ""),
    error: ok ? null : String(result?.result || processResult.stderr || `claude exited ${processResult.code}`),
    metadata: {
      model: options.model || modelEvent?.model || modelEvent?.model_name || null,
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      cacheReadTokens: usage.cache_read_input_tokens ?? null,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
      costUsd: result?.total_cost_usd ?? null,
      turns: result?.num_turns ?? null,
      durationMs: result?.duration_ms ?? null,
      stopReason: result?.subtype || null
    },
    events: processResult.events,
    stderr: processResult.stderr
  };
}

module.exports = { createClaudeAdapter, buildArgs, claudeReceipt };
