"use strict";

const { createOwnedAdapter } = require("./owned-thread");

function createClaudeAdapter(config = {}) {
  return createOwnedAdapter("claude", config, buildArgs, claudeReceipt);
}

function buildArgs(options) {
  const args = ["-p", "--input-format", "text", "--output-format", "stream-json", "--verbose"];
  if (options.sessionId) args.push("--resume", options.sessionId);
  if (options.newSessionId) args.push("--session-id", options.newSessionId);
  args.push("--max-turns", String(options.maxTurns || 12));
  if (options.model) args.push("--model", options.model);
  args.push("--permission-mode", "dontAsk", "--tools", (options.allowedTools || []).join(","), "--safe-mode", "--restricted", "--disable-slash-commands", "--no-chrome", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}');
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
  const ok = processResult.code === 0 && (!processResult.cause || processResult.cause === "EXIT") && !processResult.timedOut && !processResult.cancelled && result && !result.is_error;
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
