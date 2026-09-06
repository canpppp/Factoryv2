#!/usr/bin/env node
"use strict";

const argv = process.argv.slice(2);
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (process.env.FIXTURE_SLEEP_MS) {
    setTimeout(emit, Number(process.env.FIXTURE_SLEEP_MS));
  } else {
    emit();
  }
});

function emit() {
  if (argv.includes("exec")) return emitCodex();
  const resumeAt = argv.indexOf("--resume");
  const newAt = argv.indexOf("--session-id");
  const sessionId = resumeAt >= 0 ? argv[resumeAt + 1] : argv[newAt + 1];
  line({ type: "system", subtype: "init", session_id: sessionId });
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result: channelResult("claude") || `claude:${input.trim()}`,
    num_turns: 1,
    total_cost_usd: 0.012,
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5 }
  });
}

function emitCodex() {
  const resumeAt = argv.indexOf("resume");
  const threadId = resumeAt >= 0
    ? argv.find((value) => /^[0-9a-f-]{36}$/.test(value))
    : "11111111-1111-4111-8111-111111111111";
  line({ type: "thread.started", thread_id: threadId });
  line({ type: "item.completed", item: { type: "agent_message", text: channelResult("codex") || `codex:${input.trim()}` } });
  line({ type: "turn.completed", usage: { input_tokens: 13, output_tokens: 9, cached_input_tokens: 3 } });
}

function channelResult(engine) {
  const channel = input.match(/^CHANNEL ([^\n]+)/m)?.[1];
  const job = input.match(/^JOB ([^\n]+)/m)?.[1];
  if (!channel || !job || !input.includes("TASK ENVELOPE:")) return null;
  const envelope = parseJsonAfter("TASK ENVELOPE:");
  const manifest = parseJsonAfter("RESOLVED CONTEXT MANIFEST:");
  return JSON.stringify({
    done: true,
    channelId: channel,
    jobId: job,
    engine,
    summary: "verified fixture result",
    evidence: Array.isArray(envelope?.evidenceRequired) && envelope.evidenceRequired.length
      ? envelope.evidenceRequired
      : ["fixture-result"],
    contextManifestSha256: manifest?.sha256 || null
  });
}

function parseJsonAfter(label) {
  const start = input.indexOf(label);
  if (start < 0) return null;
  const after = input.slice(start + label.length).trimStart();
  const first = after.indexOf("{");
  if (first < 0) return null;
  let depth = 0;
  for (let index = first; index < after.length; index++) {
    const char = after[index];
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (depth === 0) {
      try { return JSON.parse(after.slice(first, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
