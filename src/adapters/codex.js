"use strict";

const { runJsonlProcess, classifiedError } = require("./process");

function createCodexAdapter(config = {}) {
  const command = config.command || process.env.FACTORYV2_CODEX_BIN || "codex";
  const active = new Map();

  function thread(threadId, options) {
    return {
      id: threadId,
      async run(prompt, hooks = {}) {
        const args = buildArgs({ ...config, ...options, threadId });
        let discoveredId = threadId;
        let handle;
        handle = runJsonlProcess({
          command,
          args,
          cwd: options.cwd,
          input: prompt,
          timeoutMs: options.timeoutMs || config.timeoutMs || 300000,
          onEvent(event) {
            const id = event.thread_id || event.threadId || (event.type === "thread.started" ? event.thread_id : null);
            if (id && id !== discoveredId) {
              discoveredId = id;
              active.set(id, handle);
              hooks.onThreadId?.(id);
            }
            hooks.onEvent?.(event);
          }
        });
        if (threadId) active.set(threadId, handle);
        const result = await handle.promise;
        if (threadId) active.delete(threadId);
        if (discoveredId) active.delete(discoveredId);
        const receipt = codexReceipt(result, discoveredId, options);
        if (!receipt.ok) throw classifiedError(receipt.error, { ...result, receipt });
        return receipt;
      },
      cancel() { return cancelThread(threadId); }
    };
  }

  function cancelThread(threadId) {
    return !!(threadId && active.get(threadId)?.cancel());
  }

  return {
    engine: "codex",
    startThread(options = {}) { return thread(null, options); },
    resumeThread(threadId, options = {}) {
      if (!threadId) throw classifiedError("thread id is required", { stderr: "thread not found" });
      return thread(threadId, options);
    },
    cancelThread
  };
}

function buildArgs(options) {
  const sandbox = options.readOnly ? "read-only" : "workspace-write";
  const global = ["--sandbox", sandbox, "--ask-for-approval", "never", "--cd", options.cwd];
  const common = ["--json", "--skip-git-repo-check"];
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
  const ok = processResult.code === 0 && !processResult.timedOut && !processResult.cancelled && !failed;
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
