"use strict";

const fs = require("node:fs");
const { identity, inventory, signal, same, pin } = require("./linux-ownership-host");
const [token, expiryText, report] = process.argv.slice(2);
const expiry = Number(expiryText);
const ownNamespace = identity(process.pid).namespace;
const namespaces = new Set(), known = new Map(), interventions = [];
const namespacePins = [];
let stopped = false;
function sample() {
  for (const item of inventory(token, [...namespaces])) {
    if (item.pid === process.pid) continue;
    known.set(`${item.pid}:${item.start}`, item);
    if (item.namespace && item.namespace !== ownNamespace && !namespaces.has(item.namespace)) {
      namespacePins.push(pin(item)); namespaces.add(item.namespace);
    }
  }
}
function finish() {
  if (stopped) return;
  stopped = true;
  sample();
  fs.writeFileSync(report, JSON.stringify({ interventions, identities: [...known.values()], remaining: [...known.values()].map(same).filter((item) => item && item.state !== "Z") }));
  namespacePins.forEach((fd) => fs.closeSync(fd));
  process.exit(0);
}
process.on("message", (message) => { if (message === "finish") finish(); });
const poll = setInterval(() => {
  sample();
  if (Date.now() >= expiry) {
    for (const saved of known.values()) if (signal(saved, "SIGKILL")) interventions.push(saved);
    clearInterval(poll);
    setTimeout(finish, 1000);
  }
}, 25);
process.send({ type: "watchdog-ready" });
