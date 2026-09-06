"use strict";

const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const capture = (fn) => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, code: error.code }; } };

if (argv[0] === "--tree-child") {
  process.on("SIGTERM", () => {});
  if (argv[2] === "child") spawn(process.execPath, [__filename, "--tree-child", argv[1], "grandchild"], { stdio: "ignore", env: process.env });
  fs.writeFileSync(`${argv[1]}/${argv[2]}.pid`, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const envelope = JSON.parse(input.split("TASK ENVELOPE:\n")[1].split("\n")[0]);
    const manifest = JSON.parse(input.split("RESOLVED CONTEXT MANIFEST:\n")[1].split("\n")[0]);
    const request = JSON.parse(envelope.objective);
    if (request.mode === "slow") return setTimeout(() => emit({ type: "late" }), 60000);
    if (request.mode === "tree") {
      process.on("SIGTERM", () => {});
      fs.writeFileSync(`${request.dir}/parent.pid`, String(process.pid));
      spawn(process.execPath, [__filename, "--tree-child", request.dir, "child"], { stdio: "ignore", env: process.env });
      return setInterval(() => {}, 1000);
    }
    if (request.mode === "line") return process.stdout.write("x".repeat(4096));
    if (request.mode === "stderr") return process.stderr.write("x".repeat(4096));
    if (request.mode === "invalid") return process.stdout.write("invalid\n".repeat(100));
    if (request.mode === "events") { for (let i = 0; i < 100; i++) emit({ type: "tick" }); return; }
    const index = argv.indexOf("--tools");
    const observed = {
      read: capture(() => fs.readFileSync(request.allowed, "utf8")),
      outside: capture(() => fs.readFileSync(request.outside, "utf8")),
      symlink: capture(() => fs.readFileSync(request.symlink, "utf8")),
      write: capture(() => { fs.writeFileSync(request.write, "allowed"); return true; }),
      outsideWrite: capture(() => { fs.writeFileSync(request.outsideWrite, "denied"); return true; }),
      escapeWrite: capture(() => { fs.writeFileSync(request.escapeWrite, "denied"); return true; }),
      ambient: ["FACTORY_M0_SENTINEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NODE_OPTIONS", "CLAUDE_CODE_OAUTH_TOKEN"].filter((key) => process.env[key]),
      path: process.env.PATH, home: process.env.HOME,
      tools: index < 0 ? null : argv[index + 1],
      disallowedTools: argv.includes("--disallowedTools") ? argv[argv.indexOf("--disallowedTools") + 1] : null,
      safe: argv.includes("--safe-mode") && argv.includes("--restricted") && argv.includes("--strict-mcp-config"),
      shell: spawnSync("/bin/sh", ["-c", "exit 0"], { encoding: "utf8" }).status
    };
    const response = JSON.stringify({ done: true, channelId: envelope.channel, jobId: input.match(/^JOB (.*)$/m)[1], contextManifestSha256: manifest.sha256, evidence: ["fixture-result"], summary: JSON.stringify(observed) });
    if (argv.includes("exec")) {
      emit({ type: "thread.started", thread_id: "11111111-1111-4111-8111-111111111111" });
      emit({ type: "item.completed", item: { type: "agent_message", text: response } });
      emit({ type: "turn.completed" });
    } else {
      const id = argv[argv.indexOf(argv.includes("--resume") ? "--resume" : "--session-id") + 1];
      emit({ type: "result", session_id: id, result: response, is_error: false });
    }
  });
}
