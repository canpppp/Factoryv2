"use strict";

const { createOwnedAdapter } = require("./owned-thread");

function createCodexAdapter(config = {}) {
  return createOwnedAdapter("codex", config, buildArgs, codexReceipt);
}

function buildArgs(options) {
  const sandbox = options.readOnly ? "read-only" : "workspace-write";
  const global = ["--sandbox", sandbox, "--ask-for-approval", "never", "--cd", options.cwd];
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"];
  if (options.model) common.push("--model", options.model);
  if (options.threadId) return [...global, "exec", "resume", ...common, options.threadId, "-"];
  return [...global, "exec", ...common, "-"];
}

function codexReceipt(processResult, threadId, options = {}) {
  const messages = processResult.events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text || "");
  const completed = [...processResult.events].reverse().find((event) => event.type === "turn.completed");
  const failed = [...processResult.events].reverse().find((event) => /failed|error/.test(event.type || ""));
  const usage = completed?.usage || {};
  const ok = processResult.code === 0 && (!processResult.cause || processResult.cause === "EXIT") && !processResult.timedOut && !processResult.cancelled && !failed && !!completed && !!threadId && messages.length > 0;
  return {
    ok,
    engine: "codex",
    sessionId: threadId,
    threadId,
    finalResponse: messages.at(-1) || "",
    error: ok ? null : String(failed?.message || processResult.stderr || `codex exited ${processResult.code}`),
    metadata: {
      model: options.model || null,
      inputTokens: usage.input_tokens ?? usage.inputTokens ?? null,
      outputTokens: usage.output_tokens ?? usage.outputTokens ?? null,
      cacheReadTokens: usage.cached_input_tokens ?? usage.cachedInputTokens ?? null,
      cacheWriteTokens: null,
      costUsd: null,
      turns: 1,
      stopReason: failed ? failed.type : "completed"
    },
    events: processResult.events,
    stderr: processResult.stderr
  };
}

module.exports = { createCodexAdapter, buildArgs, codexReceipt };
