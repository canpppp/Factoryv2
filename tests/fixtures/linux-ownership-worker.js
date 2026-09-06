"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.argv[2] === "--sandbox") {
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const envelope = JSON.parse(input.split("TASK ENVELOPE:\n")[1].split("\n")[0]);
    const manifest = JSON.parse(input.split("RESOLVED CONTEXT MANIFEST:\n")[1].split("\n")[0]);
    const request = JSON.parse(envelope.objective);
    tree(request.dir, request.token, String(request.expiry), "leader", request.mode, { envelope, manifest, jobId: input.match(/^JOB (.*)$/m)[1] });
  });
} else tree(...process.argv.slice(2));

function tree(dir, token, expiryText, role = "leader", mode = "tree", context) {
const expiry = Number(expiryText);
if (!dir || !token || !Number.isSafeInteger(expiry) || expiry > Date.now() + 30000) process.exit(64);
setTimeout(() => process.exit(90), Math.max(1, expiry - Date.now()));
process.on("SIGTERM", () => {
  if (role === "leader") process.stdout.write(`${JSON.stringify({ type: "late-success", token })}\n`);
});
if (role !== "grandchild") {
  const child = spawn(process.execPath, [__filename, dir, token, expiryText, role === "leader" ? "child" : "grandchild", mode], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}
fs.writeFileSync(`${dir}/${role}.json`, JSON.stringify({ pid: process.pid, token }));
if (role === "leader") {
  const poll = setInterval(() => {
    if (!fs.existsSync(`${dir}/go`)) return;
    clearInterval(poll);
    if (mode === "overflow" || mode === "race") process.stdout.write("x".repeat(8192));
    else if (mode === "exit" || mode === "client-loss") {
      if (context) {
        const result = { done: true, channelId: context.envelope.channel, jobId: context.jobId, contextManifestSha256: context.manifest.sha256, evidence: ["synthetic-client-loss"], summary: "completed after client exit" };
        for (const event of [
          { type: "thread.started", thread_id: token },
          { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } },
          { type: "turn.completed" }
        ]) process.stdout.write(`${JSON.stringify(event)}\n`);
      } else process.stdout.write(`${JSON.stringify({ type: "complete", token })}\n`);
      process.exit(0);
    } else process.stdout.write(`${JSON.stringify({ type: "ready", token })}\n`);
  }, 10);
}
}
