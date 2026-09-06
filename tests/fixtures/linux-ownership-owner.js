"use strict";

const fs = require("node:fs");
const { compileWorkerPolicy, prepareWorker } = require("../../src/adapters/worker-policy");
const { runJsonlProcess } = require("../../src/adapters/process");

const [configPath, token] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
setTimeout(() => process.exit(91), Math.max(1, config.expiry - Date.now()));
const profile = compileWorkerPolicy("codex", config.provider, { cwd: config.dir, allowedTools: ["Read", "Write"], timeoutMs: config.timeoutMs });
const prepared = prepareWorker(profile, [config.dir, token, String(config.expiry), "leader", config.mode]);
const handle = runJsonlProcess({ ...prepared, cwd: config.dir, timeoutMs: profile.timeoutMs, limits: config.limits,
  onSpawn(child) { process.send({ type: "spawn", pid: child.pid }); },
  onEvent(event) { process.send({ type: "event", event }); }
});
process.on("message", (message) => { if (message === "cancel") process.send({ type: "cancel", accepted: handle.cancel() }); });
handle.promise.then((result) => {
  process.send({ type: "settled", result });
  // Keep the actual owner alive so it cannot mask a missing cleanup condition.
  process.on("message", (message) => { if (message === "finish") process.exit(0); });
});
