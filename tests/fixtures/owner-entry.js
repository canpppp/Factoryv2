"use strict";

// Only synthetic CI loads this preload. Barriers hold production consumers at
// precise transitions; no production configuration exposes these controls.
const fs = require("node:fs");
const path = require("node:path");
const [configPath, token, kind, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
setTimeout(() => process.exit(91), Math.max(1, config.expiry - Date.now())).unref();
function barrier(stage, evidence = {}) {
  fs.writeFileSync(path.join(config.control, stage), JSON.stringify(evidence));
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(path.join(config.control, "release-" + stage))) {
    if (Date.now() > deadline) process.exit(92);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (kind === "daemon") {
  const cp = require("node:child_process"), spawn = cp.spawn;
  cp.spawn = function(command, argv, options) {
    // Harmless argv marker lets the independent watchdog identify bwrap even
    // before worker release. Containment options and process consumer are intact.
    if (command === "/usr/bin/bwrap") argv = ["--setenv", "FACTORY_FIXTURE_TOKEN", token, ...argv];
    return spawn.call(this, command, argv, options);
  };
  const ownership = require("../../src/execution-owner"), acquire = ownership.acquire;
  ownership.acquire = async (...values) => {
    const owner = await acquire(...values), ready = owner.ready;
    owner.ready = () => {
      if (config.stage === "before-ready") barrier("before-ready");
      return ready();
    };
    return owner;
  };
  const journal = require("../../src/journal"), append = journal.append;
  journal.append = (...values) => {
    const event = append(...values);
    if (config.stage === "admitted" && event.type === "owner.request.admitted") barrier("admitted");
    if (config.stage === "prepare-partial" && event.type === "mission.created" && event.preparationRequestId) barrier("prepare-partial");
    return event;
  };
  const linux = require("../../src/adapters/linux-ownership"), create = linux.createLinuxOwnership;
  linux.createLinuxOwnership = (pid) => {
    const observer = create(pid), end = observer.end, observe = observer.observe;
    let held = false;
    observer.end = () => {
      if (config.stage === "before-identity") barrier("before-identity", { backendPid: pid, receipt: observer.receipt() });
      return end();
    };
    observer.observe = () => {
      const state = observe();
      if (!held && state === "ACTIVE" && config.stage === "before-release") {
        held = true; barrier("before-release", { backendPid: pid, receipt: observer.receipt() });
      }
      return state;
    };
    return observer;
  };
}
process.argv = [process.execPath, path.resolve(__dirname, "../../bin", kind === "daemon" ? "factoryd.js" : "factoryv2.js"), ...args];
require(process.argv[1]);
