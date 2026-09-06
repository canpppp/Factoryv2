"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createDaemon } = require("../../src/daemon");
const [configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
setTimeout(() => process.exit(91), Math.max(1, config.expiry - Date.now()));
const definitionsPath = path.join(config.root, "channels.json");
fs.writeFileSync(definitionsPath, JSON.stringify([{ id: "proof", cwd: config.dir, engine: "codex", allowedTools: ["Read", "Write"], writeAuthority: "workspace", readWriteProfile: "workspace-write", capsule: "Synthetic ownership proof", workerPolicy: { ...config.provider.workerPolicy, executable: config.provider.command } }]));
const daemon = createDaemon({ root: config.root, channelDefinitionsPath: definitionsPath, pollMs: 10, notifier() {} });
daemon.channels.ensureDefaults();
const running = daemon.start();
process.send({ type: "api", socketPath: daemon.channelApi.socketPath });
let reported = false;
const poll = setInterval(() => {
  const result = daemon.channels.result("proof");
  if (result && !reported) { reported = true; process.send({ type: "settled", result }); }
}, 10);
process.on("message", (message) => {
  if (message === "cancel") { daemon.channels.cancel("proof"); process.send({ type: "cancel" }); }
  if (message === "finish") daemon.stop();
});
running.then(() => { clearInterval(poll); process.exit(0); }).catch((error) => { console.error(error); process.exit(1); });
