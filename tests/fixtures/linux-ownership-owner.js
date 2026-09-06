"use strict";

const fs = require("node:fs");
const { compileWorkerPolicy, prepareWorker } = require("../../src/adapters/worker-policy");
const { runJsonlProcess } = require("../../src/adapters/process");
const { identity, inventory, pin } = require("./linux-ownership-host");

const [configPath, token] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
setTimeout(() => process.exit(91), Math.max(1, config.expiry - Date.now()));
const profile = compileWorkerPolicy("codex", config.provider, { cwd: config.dir, allowedTools: ["Read", "Write"], timeoutMs: config.timeoutMs });
const prepared = prepareWorker(profile, [config.dir, token, String(config.expiry), "leader", config.mode]);
if (config.mode === "info-malformed") prepared.args[prepared.args.indexOf("--info-fd") + 1] = "2";
const namespaces = new Set(), hostNamespace = identity(process.pid).namespace;
const namespacePins = [];
let heldUntil = 0, heldStat = null, heldPath = null, cancelAt = null, finishRequested = false, finished = false;
const readFile = fs.readFileSync;
if (config.mode === "observation-held") fs.readFileSync = function(file, ...args) {
  if (file === heldPath && Date.now() < heldUntil) return heldStat;
  return readFile.call(this, file, ...args);
};
const observe = () => {
  for (const item of inventory(token)) if (item.namespace && item.namespace !== hostNamespace && !namespaces.has(item.namespace)) {
    namespacePins.push(pin(item)); namespaces.add(item.namespace);
  }
  return inventory(token, [...namespaces]).filter((item) => namespaces.has(item.namespace) && item.state !== "Z");
};
const observer = setInterval(observe, 10);
const handle = runJsonlProcess({ ...prepared, cwd: config.dir, timeoutMs: profile.timeoutMs, limits: config.limits,
  onSpawn(child) { process.send({ type: "spawn", pid: child.pid, deadline: Date.now() + profile.timeoutMs }); },
  onEvent(event) { process.send({ type: "event", event }); }
});
process.on("message", (message) => {
  if (message === "finish") { finishRequested = true; if (finished) process.exit(0); return; }
  if (message !== "cancel") return;
  if (config.mode === "observation-held" && !cancelAt) {
    const init = observe().find((item) => item.namespacePids.at(-1) === 1);
    heldPath = `/proc/${init.pid}/stat`;
    heldStat = readFile(heldPath, "utf8");
    heldUntil = Date.now() + 200;
  }
  cancelAt ??= Date.now();
  process.send({ type: "cancel", accepted: handle.cancel() });
});
handle.promise.then((result) => {
  const atSettlement = observe();
  clearInterval(observer);
  process.send({ type: "settled", result, atSettlement, namespaces: [...namespaces], afterCancelMs: cancelAt ? Date.now() - cancelAt : null });
  // Keep the actual owner alive so it cannot mask a missing cleanup condition.
  finished = true;
  if (finishRequested) process.exit(0);
});
