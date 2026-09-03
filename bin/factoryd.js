#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { createDaemon } = require("../src/daemon");

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const root = path.resolve(value("root", process.env.FACTORYV2_HOME || ".factoryv2"));
const daemon = createDaemon({ root, engine: value("engine", process.env.FACTORYV2_ENGINE || "claude"), pollMs: Number(value("poll-ms", "5000")) });
process.on("SIGTERM", () => daemon.stop());
process.on("SIGINT", () => daemon.stop());

async function main() {
  if (!argv.includes("--once")) return daemon.start();
  const journal = require("../src/journal");
  journal.append(root, { type: "daemon.started", pid: process.pid, engine: value("engine", process.env.FACTORYV2_ENGINE || "claude"), once: true });
  try { return await daemon.runOnce(); }
  finally { journal.append(root, { type: "daemon.stopped", pid: process.pid, once: true }); }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
