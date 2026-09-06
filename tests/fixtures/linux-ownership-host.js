"use strict";

const fs = require("node:fs");

function identity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    let namespace = null;
    try { namespace = fs.readlinkSync(`/proc/${pid}/ns/pid`); }
    catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const namespacePids = status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number) || [];
    return { pid: Number(pid), start: fields[19], state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), namespace, namespacePids };
  } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return null; throw error; }
}

function same(saved) {
  const current = identity(saved.pid);
  return current?.start === saved.start ? current : null;
}

function inventory(token, namespaces = []) {
  const result = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let belongs = false;
    try {
      if (fs.statSync(`/proc/${name}`).uid !== process.getuid()) continue;
      const argv = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      belongs = argv.includes(token);
      const current = identity(name);
      if (!current) continue;
      if (belongs || namespaces.includes(current.namespace)) result.push(current);
    } catch (error) {
      // CI also owns unrelated, non-dumpable services. A tagged identity must
      // remain observable; inaccessible foreign services are not test targets.
      if (error.code === "EACCES" && !belongs) continue;
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return result;
}

// Only a just-revalidated test identity may receive a signal, never a name/group.
function signal(saved, signalName) {
  const current = same(saved);
  if (!current || current.state === "Z") return false;
  process.kill(current.pid, signalName);
  return true;
}

module.exports = { identity, same, inventory, signal };
